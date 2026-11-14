import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
	getAccount,
	listAccounts,
	markAccountUsed,
	mostRecentlyUsed,
	saveAccount,
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
