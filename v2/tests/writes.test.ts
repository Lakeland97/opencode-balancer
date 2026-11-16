import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { getAccount, orderedAccounts, saveAccount } from "../core/accounts";
import { migrate } from "../core/schema";
import { clearLog, readLog } from "../server/log";
import { markRateLimited } from "../server/request-state";
import {
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
beforeEach(() => clearLog());

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
	test("move changes the order", () => {
		const db = freshDb();
		writeMove(db, { alias: "b", direction: "up", providerID: "p1" });
		expect(orderedAccounts(db).map((account) => account.alias)).toEqual([
			"b",
			"a",
		]);
	});
});
