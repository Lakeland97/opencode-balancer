import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	readRowLimit,
	readTargetLimit,
	setRowLimit,
	setTargetLimit,
} from "../core/limits";
import { migrate } from "../core/schema";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

describe("row limits", () => {
	test("a row limit reads back after it is set", () => {
		const db = freshDb();
		setRowLimit(db, "deepseek-v4.1-flash", 500_000);
		expect(readRowLimit(db, "deepseek-v4.1-flash")).toBe(500_000);
	});

	test("clearing a row limit reads back as undefined", () => {
		const db = freshDb();
		setRowLimit(db, "deepseek-v4.1-flash", 500_000);
		setRowLimit(db, "deepseek-v4.1-flash", undefined);
		expect(readRowLimit(db, "deepseek-v4.1-flash")).toBeUndefined();
	});

	test("a non-positive row limit clears the key", () => {
		const db = freshDb();
		setRowLimit(db, "deepseek-v4.1-flash", 500_000);
		setRowLimit(db, "deepseek-v4.1-flash", 0);
		expect(readRowLimit(db, "deepseek-v4.1-flash")).toBeUndefined();
	});
});

describe("target limits", () => {
	test("a target limit reads back for that provider only", () => {
		const db = freshDb();
		setTargetLimit(db, "deepseek-v4.1-flash", "p1", 250_000);
		expect(readTargetLimit(db, "deepseek-v4.1-flash", "p1")).toBe(250_000);
		expect(readTargetLimit(db, "deepseek-v4.1-flash", "p2")).toBeUndefined();
	});

	test("clearing a target limit reads back as undefined", () => {
		const db = freshDb();
		setTargetLimit(db, "deepseek-v4.1-flash", "p1", 250_000);
		setTargetLimit(db, "deepseek-v4.1-flash", "p1", undefined);
		expect(readTargetLimit(db, "deepseek-v4.1-flash", "p1")).toBeUndefined();
	});

	test("a row limit and a target limit do not collide", () => {
		const db = freshDb();
		setRowLimit(db, "deepseek-v4.1-flash", 500_000);
		setTargetLimit(db, "deepseek-v4.1-flash", "p1", 250_000);
		expect(readRowLimit(db, "deepseek-v4.1-flash")).toBe(500_000);
		expect(readTargetLimit(db, "deepseek-v4.1-flash", "p1")).toBe(250_000);
	});
});
