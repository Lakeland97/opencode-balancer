import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../core/schema";
import { now } from "../core/time";
import {
	clearUsePin,
	takeUsePin,
	usePinFor,
	writeUsePin,
} from "../server/use-pin";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

describe("the use pin", () => {
	test("a pick is read back, and age alone does not drop it", () => {
		const db = freshDb();
		// Written a year ago: a pick is an instruction, not a hint with a shelf
		// life. The row stays on it until the user picks something else or the
		// credential cannot serve.
		writeUsePin(db, "p1", "a", now() - 365 * 24 * 60 * 60 * 1000);
		expect(usePinFor(db)).toEqual({
			alias: "a",
			at: expect.any(Number),
			providerID: "p1",
		});
	});

	test("a later pick replaces the earlier one", () => {
		const db = freshDb();
		writeUsePin(db, "p1", "a");
		writeUsePin(db, "p2", "b");
		expect(usePinFor(db)?.providerID).toBe("p2");
		expect(usePinFor(db)?.alias).toBe("b");
	});

	test("clearing forgets the pick", () => {
		const db = freshDb();
		writeUsePin(db, "p1", "a");
		clearUsePin(db);
		expect(usePinFor(db)).toBeUndefined();
	});

	test("taking a pick consumes it", () => {
		const db = freshDb();
		writeUsePin(db, "p1", "a");
		expect(takeUsePin(db)?.alias).toBe("a");
		expect(usePinFor(db)).toBeUndefined();
		expect(takeUsePin(db)).toBeUndefined();
	});
});
