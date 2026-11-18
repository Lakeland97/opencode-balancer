import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "../core/schema";
import {
	noteServed,
	resetRouteMemory,
	servedFor,
} from "../server/route-memory";

const KEY = "deepseek-v4.1-flash";
const MINUTE = 60_000;
const route = { modelID: KEY, providerID: "p1" };

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

/** The stored note, read around the cache, as a restarted process would. */
function storedAt(db: Database, familyKey = KEY) {
	const value = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(`served:${familyKey}`)?.value;
	return value === undefined
		? undefined
		: (JSON.parse(value) as { at: number }).at;
}

beforeEach(() => {
	resetRouteMemory();
});

describe("a row's last served note", () => {
	test("a repeated note keeps the stored clock moving", () => {
		const db = freshDb();
		const start = 1_000_000;

		noteServed(db, KEY, route, start);
		expect(storedAt(db)).toBe(start);

		// The same target again a minute later. The panel's marker is worth
		// nothing if the stored clock never advances: the note expires while the
		// row is still serving, and the marker cannot come back.
		noteServed(db, KEY, route, start + MINUTE);
		expect(storedAt(db)).toBe(start + MINUTE);

		noteServed(db, KEY, route, start + 2 * MINUTE);
		expect(storedAt(db)).toBe(start + 2 * MINUTE);
	});

	test("the hook pair's duplicate note does not write again", () => {
		const db = freshDb();
		const at = 1_000_000;

		noteServed(db, KEY, route, at);
		noteServed(db, KEY, route, at + 5);
		expect(storedAt(db)).toBe(at);

		noteServed(db, KEY, route, at + 50_000);
		expect(storedAt(db)).toBe(at);
	});

	test("the note keeps the agent and the level actually applied", () => {
		const db = freshDb();
		const at = 1_000_000;

		// The panel's job is to say what is really answering, which is not the
		// row the user picked: a request for `max` on a connector that tops out
		// at `high` is served at `high`, and the agent that made the call is the
		// one whose name the user needs.
		noteServed(
			db,
			KEY,
			{
				agent: "build",
				alias: "a",
				applied: "high",
				modelID: KEY,
				providerID: "p1",
				variant: "max",
			},
			at,
		);

		const entry = servedFor(db, KEY, at + 1);
		expect(entry?.agent).toBe("build");
		expect(entry?.variant).toBe("max");
		expect(entry?.applied).toBe("high");
	});

	test("a different applied level is stored at once", () => {
		const db = freshDb();
		const at = 1_000_000;
		const base = { agent: "build", alias: "a", modelID: KEY, providerID: "p1" };

		noteServed(db, KEY, { ...base, applied: "high", variant: "max" }, at);
		noteServed(
			db,
			KEY,
			{ ...base, applied: "medium", variant: "medium" },
			at + 5,
		);

		// The dedupe keeps the stored clock from moving on a duplicate note; a
		// different level is not a duplicate, or the panel would keep claiming a
		// rung the row has stopped being served at.
		expect(storedAt(db)).toBe(at + 5);
		expect(servedFor(db, KEY, at + 6)?.applied).toBe("medium");
	});

	test("a different target is stored at once", () => {
		const db = freshDb();
		const at = 1_000_000;

		noteServed(db, KEY, route, at);
		noteServed(db, KEY, { modelID: KEY, providerID: "p2" }, at + 1);

		expect(storedAt(db)).toBe(at + 1);
		expect(servedFor(db, KEY, at + 2)?.providerID).toBe("p2");
	});

	test("a row that keeps serving is never judged stale", () => {
		const db = freshDb();
		const start = 1_000_000;

		// Traffic every two minutes for half an hour. Each note lands inside the
		// ten-minute window the marker lives for, so the row stays "in use".
		for (let minute = 0; minute <= 30; minute += 2) {
			const at = start + minute * MINUTE;
			noteServed(db, KEY, route, at);
			expect(servedFor(db, KEY, at)?.providerID).toBe("p1");
		}
		expect(storedAt(db)).toBe(start + 30 * MINUTE);
	});

	test("an idle row's note expires and is dropped", () => {
		const db = freshDb();
		const start = 1_000_000;

		noteServed(db, KEY, route, start);
		expect(servedFor(db, KEY, start + 11 * MINUTE)).toBeUndefined();
		expect(storedAt(db)).toBeUndefined();
	});
});
