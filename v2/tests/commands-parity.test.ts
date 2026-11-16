import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { markAccountUsed, saveAccount } from "../core/accounts";
import { saveChain } from "../core/chains";
import { migrate } from "../core/schema";
import { runCommand } from "../server/commands";
import { invalidateCatalog } from "../server/connectors";
import { clearLog, recordLog } from "../server/log";
import { markRateLimited } from "../server/request-state";
import {
	writeContextBuffer,
	writeContextLimit,
	writeModelLimit,
} from "../server/settings";

const PACKAGE = "@opencode/ai/providers/openai-compatible";
const KEY = "deepseek-v4.1-flash";
const apiAuth = (key: string) => ({ key, type: "api" as const });

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

function connectorModel(providerID: string) {
	return {
		enabled: true,
		limit: { context: 1_000_000, output: 4096 },
		modelID: KEY,
		name: "DeepSeek V4.1 Flash",
		package: PACKAGE,
		providerID,
		settings: { baseURL: `https://${providerID}.invalid/v1` },
		type: "chat",
	};
}

function workingCtx() {
	return {
		model: { list: async () => ({ data: [connectorModel("p1")] }) },
		provider: {
			list: async () => ({ data: [{ id: "p1", name: "Provider One" }] }),
		},
	} as never;
}

function chainFixture() {
	return {
		familyKey: KEY,
		label: "DeepSeek V4.1 Flash",
		package: PACKAGE,
		targets: [
			{
				baseURL: "https://p1.invalid/v1",
				modelID: KEY,
				providerID: "p1",
			},
		],
	};
}

beforeEach(() => {
	clearLog();
	invalidateCatalog();
});

describe("command read parity", () => {
	test("errors shows the park, its refill and the last attempt", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		markAccountUsed(db, "p1", "a");
		markRateLimited(db, "p1", "a", 60_000, "resets in 12d 23h");
		const out = await runCommand({ ctx: {} as never, db, raw: "errors" });
		expect(out).toContain("p1/a");
		expect(out).toContain("limited");
		expect(out).toContain("resets");
		expect(out).toContain("last tried");
	});
	test("status counts any park, not only unexpired ones", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		markRateLimited(db, "p1", "a", -5_000, "old");
		expect(await runCommand({ ctx: {} as never, db, raw: "status" })).toContain(
			"Currently rate limited: 1",
		);
	});
	test("settings reports the stored values and cut", async () => {
		const db = freshDb();
		writeContextLimit(db, "200");
		writeContextBuffer(db, "20");
		const out = await runCommand({ ctx: {} as never, db, raw: "settings" });
		expect(out).toContain("Context limit: 200");
		expect(out).toContain("Buffer: 20");
		expect(out).toContain("at 180k");
	});
	test("chains lists a stored row with its count", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		saveChain(db, chainFixture());
		const out = await runCommand({ ctx: workingCtx(), db, raw: "chains" });
		expect(out).toContain(KEY);
		expect(out).toContain("custom");
	});
	test("chain detail shows the model limit and target state", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		saveChain(db, chainFixture());
		writeModelLimit(db, KEY, "100");
		const out = await runCommand({
			ctx: workingCtx(),
			db,
			raw: `chain ${KEY}`,
		});
		expect(out).toContain("100");
		expect(out).toContain("available");
	});
	test("log shows and clears entries", async () => {
		const db = freshDb();
		recordLog("config", "a setting changed");
		expect(await runCommand({ ctx: {} as never, db, raw: "log" })).toContain(
			"a setting changed",
		);
		expect(
			await runCommand({ ctx: {} as never, db, raw: "log clear" }),
		).toContain("Cleared");
		expect(await runCommand({ ctx: {} as never, db, raw: "log" })).toContain(
			"The log is empty.",
		);
	});
	test("diag names the store and the counts", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		const out = await runCommand({ ctx: workingCtx(), db, raw: "diag" });
		expect(out).toContain("balancer.sqlite");
		expect(out).toContain("1 credential");
	});
});
