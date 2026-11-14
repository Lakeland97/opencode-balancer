import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	DEFAULT_PERCENT,
	effectiveThreshold,
	readGlobalPercent,
	readTargetPercent,
	setGlobalPercent,
	setTargetPercent,
} from "../core/context";
import { migrate } from "../core/schema";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

describe("where the conversation is cut", () => {
	test("the global share is measured against the declared window", () => {
		// The balancer tells every model it holds 1M. A 20% request is 20% of
		// that, and the host is left none the wiser.
		expect(
			effectiveThreshold({ globalPercent: 20, realContext: 1_000_000 }),
		).toBe(200_000);
	});

	test("a share past the model's own window is clamped to it", () => {
		// 30% of the declared 1M is 300k, but this model only holds 200k.
		expect(
			effectiveThreshold({ globalPercent: 30, realContext: 200_000 }),
		).toBe(200_000);
	});

	test("a per-model share is measured against that model's window", () => {
		// 50% of a 200k model is 100k, whichever the global says.
		expect(
			effectiveThreshold({
				globalPercent: 20,
				realContext: 200_000,
				targetPercent: 50,
			}),
		).toBe(100_000);
		expect(
			effectiveThreshold({
				globalPercent: 90,
				realContext: 1_000_000,
				targetPercent: 10,
			}),
		).toBe(100_000);
	});

	test("an unknown window leaves the share alone", () => {
		// A provider that reports no window must still be cut, not left to grow
		// until it is refused.
		expect(
			effectiveThreshold({ globalPercent: 20, realContext: undefined }),
		).toBe(200_000);
		expect(
			effectiveThreshold({
				globalPercent: 20,
				realContext: 0,
				targetPercent: 50,
			}),
		).toBe(500_000);
	});
});

describe("the stored shares", () => {
	test("the global share reads as its default until it is set", () => {
		const db = freshDb();
		expect(readGlobalPercent(db)).toBe(DEFAULT_PERCENT);
		expect(DEFAULT_PERCENT).toBe(20);
	});

	test("a set global share survives a reload and clearing restores the default", () => {
		const db = freshDb();
		setGlobalPercent(db, 35);
		expect(readGlobalPercent(db)).toBe(35);
		setGlobalPercent(db, undefined);
		expect(readGlobalPercent(db)).toBe(DEFAULT_PERCENT);
	});

	test("a per-model share reads back for that provider only", () => {
		const db = freshDb();
		setTargetPercent(db, "deepseek-v4.1-flash", "p1", 50);
		expect(readTargetPercent(db, "deepseek-v4.1-flash", "p1")).toBe(50);
		expect(readTargetPercent(db, "deepseek-v4.1-flash", "p2")).toBeUndefined();
		expect(readTargetPercent(db, "other-row", "p1")).toBeUndefined();
	});

	test("the global and a per-model share are separate facts", () => {
		const db = freshDb();
		setGlobalPercent(db, 30);
		setTargetPercent(db, "deepseek-v4.1-flash", "p1", 50);
		expect(readGlobalPercent(db)).toBe(30);
		expect(readTargetPercent(db, "deepseek-v4.1-flash", "p1")).toBe(50);
	});

	test("a share outside 1% to 100% is refused rather than stored", () => {
		const db = freshDb();
		for (const bad of [0, -5, 101, Number.NaN]) {
			setGlobalPercent(db, bad);
			setTargetPercent(db, "row", "p1", bad);
			expect(readGlobalPercent(db)).toBe(DEFAULT_PERCENT);
			expect(readTargetPercent(db, "row", "p1")).toBeUndefined();
		}
	});

	test("a malformed stored value reads as unset", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO settings (key, value) VALUES ('context_percent', 'lots')",
		).run();
		expect(readGlobalPercent(db)).toBe(DEFAULT_PERCENT);
	});
});
