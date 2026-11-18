import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "../core/schema";
import {
	noteServed,
	resetRouteMemory,
	servedEntries,
	servedFor,
} from "../server/route-memory";

const KEY = "deepseek-v4.1-flash";
const MINUTE = 60_000;
const route = { alias: "a", modelID: KEY, providerID: "p1" };

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

beforeEach(() => {
	resetRouteMemory();
});

describe("what is being served right now", () => {
	test("a row reports its provider, model and level", () => {
		const db = freshDb();
		const at = 1_000_000;
		noteServed(
			db,
			KEY,
			{
				alias: "open-design",
				modelID: "deepseek-v4.1-flash",
				providerID: "open-design",
				variant: "high",
			},
			at,
		);

		expect(servedFor(db, KEY, at + 1)).toMatchObject({
			alias: "open-design",
			modelID: "deepseek-v4.1-flash",
			providerID: "open-design",
			variant: "high",
		});
	});

	test("several rows being served are all reported, newest first", () => {
		const db = freshDb();
		const at = 1_000_000;
		noteServed(
			db,
			"alpha",
			{ alias: "a", modelID: "alpha", providerID: "p1", variant: "high" },
			at,
		);
		noteServed(
			db,
			"beta",
			{ alias: "b", modelID: "beta", providerID: "p2", variant: "low" },
			at + 1,
		);

		const entries = servedEntries(db, at + 2);

		expect(entries.map((entry) => entry.familyKey)).toEqual(["beta", "alpha"]);
		expect(entries.find((entry) => entry.familyKey === "alpha")?.variant).toBe(
			"high",
		);
	});

	test("a note that has aged out is not reported as current", () => {
		const db = freshDb();
		noteServed(db, KEY, route, 1_000_000);

		expect(servedEntries(db, 1_000_000 + 11 * MINUTE)).toEqual([]);
	});

	test("the same row served by a different target replaces the old note", () => {
		const db = freshDb();
		const at = 1_000_000;
		noteServed(db, KEY, route, at);
		noteServed(
			db,
			KEY,
			{ alias: "b", modelID: KEY, providerID: "p2", variant: "low" },
			at + 1,
		);

		const entries = servedEntries(db, at + 2);
		expect(entries).toHaveLength(1);
		expect(entries[0].providerID).toBe("p2");
		expect(entries[0].variant).toBe("low");
	});

	test("a stored note without a level still reports the target", () => {
		// A note written by an older build has no variant. It must still say
		// where the row is, rather than disappear for lacking a field this build
		// happens to write.
		const db = freshDb();
		db.query(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
			`served:${KEY}`,
			JSON.stringify({ at: 1_000_000, modelID: KEY, providerID: "p3" }),
		);

		const entries = servedEntries(db, 1_000_001);
		expect(entries[0].providerID).toBe("p3");
		expect(entries[0].alias).toBeUndefined();
	});
});
