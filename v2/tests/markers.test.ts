import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
	ensureActiveAlias,
	getAccount,
	getActiveAccount,
	listAccounts,
	markAccountUsed,
	mostRecentlyUsed,
	moveAccount,
	orderedAccounts,
	readLimitedReason,
	removeAccount,
	saveAccount,
	setAccountEnabled,
	setAccountFreeOnly,
	setActiveAccount,
} from "../core/accounts";
import { migrateProviderSettings, providerOrder } from "../core/priority";
import { migrate } from "../core/schema";
import { invalidateCatalog } from "../server/connectors";
import {
	errorRetryAfterMs,
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

	test("a failure in wording no list anticipates is still retryable", () => {
		// The provider that started this: a free-tier cap raised with no status
		// and not one word a keyword list would carry.
		expect(
			isRetryableFailure({
				error: new Error(
					"You've used today's free messages. They reset at 11:27 AM.",
				),
			}),
		).toBe(true);
		expect(
			isRetryableFailure({
				error: new Error("something entirely new happened"),
			}),
		).toBe(true);
	});

	test("a request-shaped failure is never charged to the account", () => {
		expect(
			isRetryableFailure({
				error: new Error("Prompt is too long for the model's context window"),
			}),
		).toBe(false);
		expect(
			isRetryableFailure({
				error: new Error("blocked by content filtering policy"),
			}),
		).toBe(false);
	});

	test("a response that was not a failure is not one here either", () => {
		expect(isRetryableFailure({ status: 200 })).toBe(false);
		expect(isRetryableFailure({})).toBe(false);
	});

	test("the wait the provider named is read off the typed error", () => {
		expect(errorRetryAfterMs({ retryAfterMs: 5_000 })).toBe(5_000);
		expect(errorRetryAfterMs({ retryAfterMs: 0 })).toBeUndefined();
		expect(errorRetryAfterMs({ retryAfterMs: -1 })).toBeUndefined();
		expect(errorRetryAfterMs({ retryAfterMs: "soon" })).toBeUndefined();
		expect(errorRetryAfterMs(undefined)).toBeUndefined();
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

	test("choosing a parked account puts it back in play", async () => {
		const db = freshDb();
		// The account the row is pointed at has hit its limit. The user picks it
		// to see whether the cooldown has passed, so the pick itself must clear
		// the park — otherwise the row looks exactly as it did and nothing is
		// ever tried again.
		markRateLimited(db, "p1", "a", 600_000, "HTTP 429");
		const rpc = await handlers(db);

		const reply = (await rpc.use({ alias: "a", providerID: "p1" })) as {
			ok: boolean;
		};
		expect(reply.ok).toBe(true);

		expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeUndefined();
		expect(readLimitedReason(db, "p1", "a")).toBeUndefined();
		const listed = (await rpc.list({})) as {
			accounts: {
				active: boolean;
				alias: string;
				limited: boolean;
				providerID: string;
			}[];
		};
		const account = listed.accounts.find(
			(entry) => entry.providerID === "p1" && entry.alias === "a",
		);
		expect(account?.limited).toBe(false);
		expect(account?.active).toBe(true);
	});

	test("a sync fills an empty selection but never steals a live one", () => {
		const db = freshDb();
		// p1 already points at `b`; the host's pick must not take that away.
		setActiveAccount(db, "p1", "b");
		ensureActiveAlias(db, "p1", "a");
		expect(getActiveAccount(db, "p1")?.alias).toBe("b");

		// With nothing selected, the host's pick becomes the selection.
		saveAccount(db, "p4", "a", { key: "k", type: "api" });
		saveAccount(db, "p4", "b", { key: "k", type: "api" });
		removeAccount(db, "p4", "a");
		ensureActiveAlias(db, "p4", "b");
		expect(getActiveAccount(db, "p4")?.alias).toBe("b");

		// A name with nothing behind it changes nothing.
		ensureActiveAlias(db, "p3", "ghost");
		expect(getActiveAccount(db, "p3")).toBeUndefined();
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

describe("the credential order", () => {
	const order = (db: Database) =>
		orderedAccounts(db).map(
			(account) => `${account.providerID}/${account.alias}`,
		);

	test("a new credential lands at the end rather than the front", () => {
		const db = freshDb();
		saveAccount(db, "p3", "z", { key: "k", type: "api" });
		const listed = order(db);
		expect(listed[listed.length - 1]).toBe("p3/z");
	});

	test("a move swaps the credential with the row it passes", () => {
		const db = freshDb();
		// p1/a sits above p1/b, so lifting b puts it above a and leaves the rest.
		moveAccount(db, "p1", "b", -1);
		expect(order(db)).toEqual(["p1/b", "p1/a", "p2/a"]);
	});

	test("a move off either end is a no-op", () => {
		const db = freshDb();
		const before = order(db);
		moveAccount(db, "p1", "a", -1);
		moveAccount(db, "p2", "a", 1);
		moveAccount(db, "nobody", "n", 1);
		expect(order(db)).toEqual(before);
	});

	test("a credential carries its own switches", () => {
		const db = freshDb();
		setAccountEnabled(db, "p1", "b", false);
		setAccountFreeOnly(db, "p1", "b", true);

		expect(getAccount(db, "p1", "b")?.disabled).toBe(true);
		expect(getAccount(db, "p1", "b")?.freeOnly).toBe(true);
		// The neighbour is untouched: these are per credential, not per provider.
		expect(getAccount(db, "p1", "a")?.disabled).toBe(false);
		expect(getAccount(db, "p1", "a")?.freeOnly).toBe(false);

		setAccountEnabled(db, "p1", "b", true);
		setAccountFreeOnly(db, "p1", "b", false);
		expect(getAccount(db, "p1", "b")?.disabled).toBe(false);
		expect(getAccount(db, "p1", "b")?.freeOnly).toBe(false);
	});
});

describe("the provider's place in the order", () => {
	test("a provider sits where its earliest credential does", () => {
		const db = freshDb();
		// p1/a is first, so p1 leads even after p2's own row moves past p1/b.
		expect([...providerOrder(db).keys()]).toEqual(["p1", "p2"]);
		moveAccount(db, "p2", "a", -1);
		expect([...providerOrder(db).keys()]).toEqual(["p1", "p2"]);
		moveAccount(db, "p2", "a", -1);
		expect([...providerOrder(db).keys()]).toEqual(["p2", "p1"]);
	});

	test("a switch that belonged to a provider is copied onto its credentials", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO settings (key, value) VALUES ('free_only:p1', '1')",
		).run();
		db.query(
			`INSERT INTO provider_priority (provider_id, position, model_id, enabled, updated_at)
             VALUES ('p1', 0, NULL, 0, 0)`,
		).run();

		migrateProviderSettings(db);

		// Every credential that provider had takes the answer it was given, and
		// no other provider is touched.
		expect(getAccount(db, "p1", "a")?.freeOnly).toBe(true);
		expect(getAccount(db, "p1", "b")?.freeOnly).toBe(true);
		expect(getAccount(db, "p1", "a")?.disabled).toBe(true);
		expect(getAccount(db, "p2", "a")?.freeOnly).toBe(false);
		expect(getAccount(db, "p2", "a")?.disabled).toBe(false);
	});

	test("the provider-level answers are forgotten, not reapplied", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO settings (key, value) VALUES ('free_only:p1', '1')",
		).run();
		db.query(
			`INSERT INTO provider_priority (provider_id, position, model_id, enabled, updated_at)
             VALUES ('p1', 0, NULL, 1, 0)`,
		).run();
		migrateProviderSettings(db);

		expect(
			db.query("SELECT key FROM settings WHERE key LIKE 'free_only:%'").all(),
		).toEqual([]);
		expect(db.query("SELECT provider_id FROM provider_priority").all()).toEqual(
			[],
		);

		// A credential added afterwards is not dragged back to the old answer.
		migrateProviderSettings(db);
		saveAccount(db, "p1", "c", { key: "k9", type: "api" });
		migrateProviderSettings(db);
		expect(getAccount(db, "p1", "c")?.freeOnly).toBe(false);
	});

	test("the order the provider had seeds the credentials that held it", () => {
		const db = freshDb();
		// Rebuilding the table for the new columns leaves every credential at
		// zero, which is the state an existing database upgrades in.
		db.query("UPDATE accounts SET position = 0").run();
		// p2 led p1 there, so it must still lead once the order is the accounts'.
		db.query(
			`INSERT INTO provider_priority (provider_id, position, model_id, enabled, updated_at)
             VALUES ('p2', 0, NULL, 1, 0)`,
		).run();
		db.query(
			`INSERT INTO provider_priority (provider_id, position, model_id, enabled, updated_at)
             VALUES ('p1', 1, NULL, 1, 0)`,
		).run();

		migrateProviderSettings(db);

		// p2/a first, then p1's own credentials together as they were.
		expect(
			orderedAccounts(db).map((a) => `${a.providerID}/${a.alias}`),
		).toEqual(["p2/a", "p1/a", "p1/b"]);
	});

	test("an order the user has already set is never resorted", () => {
		const db = freshDb();
		// p2/a lifted above p1's second credential: real positions, and a row
		// order alphabetical seeding would get wrong.
		moveAccount(db, "p2", "a", -1);
		const before = orderedAccounts(db).map((a) => `${a.providerID}/${a.alias}`);
		expect(before).toEqual(["p1/a", "p2/a", "p1/b"]);

		migrateProviderSettings(db);
		migrateProviderSettings(db);

		expect(
			orderedAccounts(db).map((a) => `${a.providerID}/${a.alias}`),
		).toEqual(before);
	});

	test("the marker lands on whatever the seeding makes lead", () => {
		const db = freshDb();
		// The state an upgrade arrives in: every credential at zero, so the
		// seeding decides the order — and p1/b is left over as the stored pick
		// from before, which the seeded order no longer agrees with.
		db.query("UPDATE accounts SET position = 0").run();
		setActiveAccount(db, "p1", "b");

		migrateProviderSettings(db);

		// p1's leader is p1/a, so that is the one the panel must call active.
		expect(orderedAccounts(db, "p1").map((a) => a.alias)).toEqual(["a", "b"]);
		expect(getActiveAccount(db, "p1")?.alias).toBe("a");
		expect(getActiveAccount(db, "p2")?.alias).toBe("a");
	});
});
