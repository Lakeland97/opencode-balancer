import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { getAccount, orderedAccounts, saveAccount } from "../core/accounts";
import { getStoredChain, saveChain } from "../core/chains";
import { migrate } from "../core/schema";
import { invalidateCatalog } from "../server/connectors";
import { clearLog, readLog } from "../server/log";
import { markRateLimited } from "../server/request-state";
import {
	writeChainAdd,
	writeChainCreate,
	writeChainMove,
	writeChainRemove,
	writeChainReset,
	writeMove,
	writeSetEnabled,
	writeSetFreeOnly,
	writeUse,
} from "../server/writes";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	saveAccount(db, "p1", "a", { key: "k1", type: "api" as const });
	saveAccount(db, "p1", "b", { key: "k2", type: "api" as const });
	return db;
}
beforeEach(() => {
	clearLog();
	invalidateCatalog();
});

const PACKAGE = "@opencode/ai/providers/openai-compatible";

function offered(providerID: string) {
	return {
		enabled: true,
		limit: { context: 1_000_000, output: 4096 },
		modelID: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		package: PACKAGE,
		providerID,
		settings: { baseURL: `https://${providerID}.invalid/v1` },
		type: "chat",
	};
}

/** A client that offers the same family on two providers. */
const ctx = {
	model: { list: async () => ({ data: [offered("p1"), offered("p2")] }) },
	provider: {
		list: async () => ({
			data: [
				{ id: "p1", name: "Provider One" },
				{ id: "p2", name: "Provider Two" },
			],
		}),
	},
} as never;

const targets = (db: Database, key: string) =>
	getStoredChain(db, key)?.targets.map((target) => target.providerID);

describe("account writes", () => {
	test("disable writes the account and a config line", () => {
		const db = freshDb();
		expect(
			writeSetEnabled(db, { alias: "a", enabled: false, providerID: "p1" }).ok,
		).toBe(true);
		expect(getAccount(db, "p1", "a")?.disabled).toBe(true);
		expect(readLog().at(-1)?.text).toBe("p1/a disabled");
	});
	test("free-only writes the flag and a config line", () => {
		const db = freshDb();
		expect(
			writeSetFreeOnly(db, { alias: "a", enabled: true, providerID: "p1" }).ok,
		).toBe(true);
		expect(getAccount(db, "p1", "a")?.freeOnly).toBe(true);
		expect(readLog().at(-1)?.text).toBe("p1/a free models only");
	});
	test("use clears a park and records the pick", () => {
		const db = freshDb();
		markRateLimited(db, "p1", "a", 60_000, "resets in 1h");
		expect(writeUse(db, { alias: "a", providerID: "p1" }).ok).toBe(true);
		expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeUndefined();
		expect(readLog().at(-1)?.text).toBe("serving with p1/a");
	});
	test("use puts the picked credential at the head of the whole order", () => {
		const db = freshDb();
		saveAccount(db, "p2", "a", { key: "k3", type: "api" as const });
		// One credential per provider: moving it to the head of its own
		// provider's block moves nothing at all, so the pick has to travel the
		// order every provider shares or selecting it does nothing visible.
		expect(writeUse(db, { alias: "a", providerID: "p2" }).ok).toBe(true);
		expect(
			orderedAccounts(db).map(
				(account) => `${account.providerID}/${account.alias}`,
			),
		).toEqual(["p2/a", "p1/a", "p1/b"]);
	});
	test("move changes the order", () => {
		const db = freshDb();
		writeMove(db, { alias: "b", direction: "up", providerID: "p1" });
		expect(orderedAccounts(db).map((account) => account.alias)).toEqual([
			"b",
			"a",
		]);
	});
});

describe("chain writes", () => {
	test("create, add, move and reset a chain", async () => {
		const db = freshDb();
		const created = await writeChainCreate(ctx, db, {
			modelID: "deepseek-v4.1-flash",
			providerID: "p1",
		});
		expect(created.ok).toBe(true);
		expect(created.key).toBe("deepseek-v4.1-flash");
		expect(targets(db, created.key)).toEqual(["p1"]);

		expect(
			(
				await writeChainAdd(ctx, db, {
					key: created.key,
					modelID: "deepseek-v4.1-flash",
					providerID: "p2",
				})
			).ok,
		).toBe(true);
		expect(targets(db, created.key)).toEqual(["p1", "p2"]);

		expect(
			(
				await writeChainMove(ctx, db, {
					direction: "up",
					key: created.key,
					providerID: "p2",
				})
			).ok,
		).toBe(true);
		expect(targets(db, created.key)).toEqual(["p2", "p1"]);

		expect(
			(
				await writeChainRemove(ctx, db, {
					key: created.key,
					providerID: "p2",
				})
			).ok,
		).toBe(true);
		expect(targets(db, created.key)).toEqual(["p1"]);

		expect((await writeChainReset(ctx, db, created.key)).ok).toBe(true);
		expect(getStoredChain(db, created.key)).toBeUndefined();
	});
	test("an unknown row is refused without writing", async () => {
		const db = freshDb();
		const added = await writeChainAdd(ctx, db, {
			key: "missing",
			modelID: "x",
			providerID: "p1",
		});
		expect(added).toMatchObject({
			message: "No row named missing.",
			ok: false,
		});
		const reset = await writeChainReset(ctx, db, "missing");
		expect(reset).toMatchObject({
			message: "No row named missing.",
			ok: false,
		});
		expect(readLog()).toHaveLength(0);
	});
});

describe("create safety", () => {
	test("create refuses to replace an existing chain", async () => {
		const db = freshDb();
		const target = (providerID: string) => ({
			baseURL: `https://${providerID}.invalid/v1`,
			modelID: "deepseek-v4.1-flash",
			providerID,
		});
		saveChain(db, {
			familyKey: "deepseek-v4.1-flash",
			label: "DeepSeek V4.1 Flash",
			package: PACKAGE,
			targets: [target("p1"), target("p2")],
		});

		const created = await writeChainCreate(ctx, db, {
			modelID: "deepseek-v4.1-flash",
			providerID: "p1",
		});

		expect(created.ok).toBe(false);
		expect(created.key).toBe("");
		expect(targets(db, "deepseek-v4.1-flash")).toEqual(["p1", "p2"]);
	});
});
