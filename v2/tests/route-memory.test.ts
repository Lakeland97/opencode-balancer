import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "../core/schema";
import {
	noteAnswered,
	noteIdle,
	noteServed,
	noteSessionTokens,
	resetRouteMemory,
	servedEntries,
	servedFor,
	sessionTokens,
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

describe("two stores in one process", () => {
	test("a note written for one store is not read back from another", () => {
		const first = freshDb();
		const second = freshDb();
		const at = 1_000_000;

		noteServed(first, KEY, route, at);

		// The panel asks one database what is in use. Answering from another's
		// memory is how a test's own route made a second, untouched account list
		// report a credential it had never sent anything to.
		expect(servedFor(second, KEY, at + 1)).toBeUndefined();
		expect(servedEntries(second, at + 1)).toEqual([]);
		// And the store that owns the note still has it.
		expect(servedFor(first, KEY, at + 1)?.providerID).toBe("p1");
	});

	test("a conversation size belongs to its own store", () => {
		const first = freshDb();
		const second = freshDb();

		noteSessionTokens(first, "session-a", 12_000);

		expect(sessionTokens(second, "session-a")).toBeUndefined();
		expect(sessionTokens(first, "session-a")).toBe(12_000);
	});
});

describe("whether a row is working", () => {
	test("a request on its way marks the row, and the answer stamps the clock", () => {
		const db = freshDb();
		const asked = 1_000_000;
		const answered = asked + 3 * MINUTE;

		noteServed(db, KEY, { ...route, working: true }, asked);
		expect(servedFor(db, KEY, asked + 1)?.working).toBe(true);
		// The clock still says when it was asked, because that is when the
		// request went out; the flag is what says it is not idle.
		expect(servedFor(db, KEY, asked + 1)?.at).toBe(asked);

		noteAnswered(db, KEY, answered);
		expect(servedFor(db, KEY, answered + 1)?.working).toBe(false);
		// A three-minute answer must not leave the panel saying "3m ago" for the
		// whole three minutes: the clock is when the row last answered.
		expect(servedFor(db, KEY, answered + 1)?.at).toBe(answered);
	});

	test("the answer is what the panel's clock moves on", () => {
		const db = freshDb();
		const asked = 1_000_000;

		noteServed(db, KEY, route, asked);
		noteAnswered(db, KEY, asked + 90_000);
		expect(storedAt(db)).toBe(asked + 90_000);
	});

	test("a note for a row with no mark is not invented by an answer", () => {
		const db = freshDb();

		noteAnswered(db, KEY, 1_000_000);
		expect(servedFor(db, KEY, 1_000_001)).toBeUndefined();
	});

	test("a request hook's note keeps the working mark the answer will clear", () => {
		const db = freshDb();
		const at = 1_000_000;

		noteServed(db, KEY, { ...route, working: true }, at);
		// The HTTP hook stamps the same target a few milliseconds later without
		// naming the flag; dropping it there would make the panel say the row had
		// gone idle while its request was still open.
		noteServed(db, KEY, route, at + 5);
		expect(servedFor(db, KEY, at + 6)?.working).toBe(true);
	});
});

describe("a row nothing answered", () => {
	test("a walk that produced no answer stops claiming to be working", () => {
		const db = freshDb();
		const asked = 1_000_000;

		noteServed(db, KEY, { ...route, working: true }, asked);
		noteIdle(db, KEY, asked + 1);

		const entry = servedFor(db, KEY, asked + 2);
		expect(entry?.working).toBe(false);
		// A refusal is not an answer, so the clock stays where the last real
		// answer left it.
		expect(entry?.at).toBe(asked);
	});

	test("idling a row that was already idle changes nothing", () => {
		const db = freshDb();
		const at = 1_000_000;

		noteServed(db, KEY, route, at);
		noteIdle(db, KEY, at + 1);
		expect(storedAt(db)).toBe(at);
		// A note never marked working stays unmarked: idling it writes nothing.
		expect(servedFor(db, KEY, at + 2)?.working).toBeUndefined();
	});
});
