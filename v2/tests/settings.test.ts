import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
	readBuffer,
	readBufferEnforcement,
	readLimit,
	readModelLimit,
} from "../core/context";
import { getBalancingEnabled } from "../core/priority";
import { getRebalanceAuto, readRebalance } from "../core/rebalance";
import { migrate } from "../core/schema";
import { clearLog, readLog } from "../server/log";
import {
	writeBalancing,
	writeBufferEnforcement,
	writeContextBuffer,
	writeContextLimit,
	writeModelLimit,
	writeRebalance,
	writeRebalanceAuto,
} from "../server/settings";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}
beforeEach(() => clearLog());

describe("setting writes", () => {
	test("a limit writes, logs and reports", () => {
		const db = freshDb();
		expect(writeContextLimit(db, "200")).toEqual({
			message: "Context limit is 200k.",
			ok: true,
		});
		expect(readLimit(db)).toBe("200");
		expect(readLog().at(-1)).toMatchObject({ kind: "config" });
	});
	test("a bad limit writes nothing", () => {
		const db = freshDb();
		expect(writeContextLimit(db, "soon").ok).toBe(false);
		expect(readLimit(db)).toBeUndefined();
		expect(readLog()).toHaveLength(0);
	});
	test("buffer and enforcement are separate writes", () => {
		const db = freshDb();
		expect(writeContextBuffer(db, "20").ok).toBe(true);
		expect(writeBufferEnforcement(db, "necessary").ok).toBe(true);
		expect(readBuffer(db)).toBe("20");
		expect(readBufferEnforcement(db)).toBe("necessary");
		expect(writeBufferEnforcement(db, "sometimes").ok).toBe(false);
	});
	test("a rebalance length sets the switch, zero shuts it", () => {
		const db = freshDb();
		writeRebalance(db, "90m");
		expect(readRebalance(db)).toBe("90m");
		expect(getRebalanceAuto(db)).toBe(true);
		writeRebalance(db, "0");
		expect(getRebalanceAuto(db)).toBe(false);
		writeRebalanceAuto(db, true);
		expect(readRebalance(db)).toBe("");
	});
	test("a model limit is stored against its row", () => {
		const db = freshDb();
		expect(writeModelLimit(db, "deepseek", "100").ok).toBe(true);
		expect(readModelLimit(db, "deepseek")).toBe("100");
	});
	test("balancing writes and logs", () => {
		const db = freshDb();
		writeBalancing(db, true);
		expect(getBalancingEnabled(db)).toBe(true);
	});
});
