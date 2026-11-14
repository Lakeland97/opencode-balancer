import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
	getAccount,
	importAccount,
	listAccounts,
	markAccountUsed,
	mostRecentlyUsed,
	saveAccount,
	setHostActiveSource,
} from "../core/accounts";
import { migrate } from "../core/schema";
import { invalidateCatalog } from "../server/connectors";
import {
	isRetryableFailure,
	markRateLimited,
	RETRYABLE_STATUS,
} from "../server/request-state";
import { registerBalancerRpc } from "../server/rpc";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	saveAccount(db, "p1", "a", { key: "k1", type: "api" });
	saveAccount(db, "p1", "b", { key: "k2", type: "api" });
	saveAccount(db, "p2", "a", { key: "k3", type: "api" });
	return db;
}

async function handlers(db: Database) {
	const ctx = {
		model: { list: async () => ({ data: [] }) },
		provider: { list: async () => ({ data: [] }) },
		rpc: {
			register: async (
				_definition: unknown,
				registered: Record<string, unknown>,
			) => ({
				...registered,
				events: { emit: async () => {} },
			}),
		},
	} as never;
	return (await registerBalancerRpc({ ctx, db })) as unknown as Record<
		string,
		(input: unknown) => Promise<unknown>
	>;
}

beforeEach(() => {
	invalidateCatalog();
});

describe("failure classification", () => {
	test("billing and auth statuses are retryable", () => {
		expect(RETRYABLE_STATUS.has(402)).toBe(true);
		expect(isRetryableFailure({ status: 402 })).toBe(true);
		expect(isRetryableFailure({ status: 401 })).toBe(true);
		expect(isRetryableFailure({ status: 403 })).toBe(true);
	});

	test("rate limits and server faults are retryable", () => {
		expect(isRetryableFailure({ status: 429 })).toBe(true);
		expect(isRetryableFailure({ status: 503 })).toBe(true);
		expect(isRetryableFailure({ status: 599 })).toBe(true);
	});

	test("a plain bad request is not retryable", () => {
		expect(isRetryableFailure({ status: 400 })).toBe(false);
		expect(isRetryableFailure({ status: 404 })).toBe(false);
		expect(
			isRetryableFailure({ error: new Error("Invalid request body") }),
		).toBe(false);
	});

	test("a quota error without a status is retryable", () => {
		expect(
			isRetryableFailure({
				error: new Error("Insufficient balance. Top up at example"),
			}),
		).toBe(true);
		expect(
			isRetryableFailure({
				error: Object.assign(new Error("nope"), { name: "QuotaExceeded" }),
			}),
		).toBe(true);
		expect(isRetryableFailure({ error: new Error("Too many requests") })).toBe(
			true,
		);
	});
});

describe("account usage", () => {
	test("markAccountUsed records the moment and mostRecentlyUsed finds it", () => {
		const db = freshDb();
		expect(mostRecentlyUsed(db)).toBeUndefined();

		markAccountUsed(db, "p1", "a", 1_000);
		markAccountUsed(db, "p2", "a", 2_000);

		expect(getAccount(db, "p1", "a")?.lastUsedAt).toBe(1_000);
		expect(mostRecentlyUsed(db)).toEqual({
			alias: "a",
			at: 2_000,
			providerID: "p2",
		});
	});
});

describe("account markers", () => {
	test("a park outlives its window until the account is tried again", async () => {
		const db = freshDb();
		// A zero window expires immediately: the marker must still read as
		// limited until routing comes back around to it.
		markRateLimited(db, "p1", "a", 0, "HTTP 429 Too Many Requests");
		const rpc = await handlers(db);

		const listed = (await rpc.list({})) as {
			accounts: {
				alias: string;
				limited: boolean;
				limitedReason: string;
				providerID: string;
			}[];
		};
		const account = listed.accounts.find(
			(entry) => entry.providerID === "p1" && entry.alias === "a",
		);
		expect(account?.limited).toBe(true);
		expect(account?.limitedReason).toBe("HTTP 429 Too Many Requests");

		// Being tried is what clears it, not the clock.
		markAccountUsed(db, "p1", "a");
		const after = (await rpc.list({})) as {
			accounts: {
				alias: string;
				limited: boolean;
				limitedReason: string;
				providerID: string;
			}[];
		};
		const cleared = after.accounts.find(
			(entry) => entry.providerID === "p1" && entry.alias === "a",
		);
		expect(cleared?.limited).toBe(false);
		expect(cleared?.limitedReason).toBe("");
	});

	test("a park with no recorded reason says so rather than showing nothing", async () => {
		const db = freshDb();
		// Parks made before the reason was kept, and any failure the host
		// describes with neither words nor a status, look like this.
		markRateLimited(db, "p1", "a", 60_000);
		const rpc = await handlers(db);

		const listed = (await rpc.list({})) as {
			accounts: {
				alias: string;
				limited: boolean;
				limitedReason: string;
				providerID: string;
			}[];
		};
		const account = listed.accounts.find(
			(entry) => entry.providerID === "p1" && entry.alias === "a",
		);

		expect(account?.limited).toBe(true);
		expect(account?.limitedReason).toBe("no reason was recorded for this park");
	});

	test("the account OpenCode is pointed at is marked as such", async () => {
		const db = freshDb();
		importAccount(db, {
			auth: { key: "k1", type: "api" },
			label: "Personal",
			providerID: "p1",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: { key: "k2", type: "api" },
			label: "Work",
			providerID: "p1",
			sourceID: "cred_2",
		});
		setHostActiveSource(db, "p1", "cred_2");
		const rpc = await handlers(db);

		const listed = (await rpc.list({})) as {
			accounts: { alias: string; hostActive: boolean; providerID: string }[];
		};
		const hostActive = (alias: string) =>
			listed.accounts.find(
				(entry) => entry.providerID === "p1" && entry.alias === alias,
			)?.hostActive;

		expect(hostActive("work")).toBe(true);
		expect(hostActive("personal")).toBe(false);
		// A hand-added or never-imported account has no credential behind it.
		expect(hostActive("a")).toBe(false);
	});

	test("only the most recently used account is in use", async () => {
		const db = freshDb();
		markAccountUsed(db, "p1", "b", 5_000);
		const rpc = await handlers(db);

		const listed = (await rpc.list({})) as {
			accounts: { alias: string; inUse: boolean; providerID: string }[];
		};
		const inUse = listed.accounts.filter((account) => account.inUse);
		expect(inUse).toHaveLength(1);
		expect(inUse[0]?.providerID).toBe("p1");
		expect(inUse[0]?.alias).toBe("b");
	});

	test("a limited account is not also reported active", async () => {
		const db = freshDb();
		markRateLimited(db, "p1", "a");
		const rpc = await handlers(db);

		const listed = (await rpc.list({})) as {
			accounts: {
				active: boolean;
				alias: string;
				limited: boolean;
				providerID: string;
			}[];
		};
		const row = listed.accounts.find(
			(account) => account.providerID === "p1" && account.alias === "a",
		);
		expect(row?.limited).toBe(true);
		expect(row?.active).toBe(false);
	});

	test("listAccounts keeps reading usage back", () => {
		const db = freshDb();
		markAccountUsed(db, "p1", "a", 42);
		expect(
			listAccounts(db, "p1").find((a) => a.alias === "a")?.lastUsedAt,
		).toBe(42);
	});
});
