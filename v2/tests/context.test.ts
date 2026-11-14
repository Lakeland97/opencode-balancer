import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	compactionReserve,
	DEFAULT_PERCENT,
	effectiveThreshold,
	migrateModelPercent,
	parseBuffer,
	readBuffer,
	readBufferSpec,
	readGlobalPercent,
	readModelPercent,
	setBuffer,
	setGlobalPercent,
	setModelPercent,
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

	test("a share past the model's own window is clamped below it", () => {
		// 30% of the declared 1M is 300k, but this model only holds 200k, and the
		// cut keeps a reserve free, so it lands at 180k.
		expect(
			effectiveThreshold({ globalPercent: 30, realContext: 200_000 }),
		).toBe(180_000);
	});

	test("the ceiling leaves the compaction its own room", () => {
		// The cut may not sit at the model's last token: compacting is another
		// request against the same model, and it carries the conversation with it.
		expect(
			effectiveThreshold({ globalPercent: 100, realContext: 200_000 }),
		).toBe(180_000);
		// A tenth of a 1M window is the larger reserve, so the cut stops at 900k.
		expect(
			effectiveThreshold({ globalPercent: 100, realContext: 1_000_000 }),
		).toBe(900_000);
		// A window too small to give up 20k gives up a quarter instead, rather
		// than being left with nowhere to hold a conversation.
		expect(
			effectiveThreshold({ globalPercent: 100, realContext: 32_000 }),
		).toBe(24_000);
		// A share that already lands below the ceiling is untouched by it.
		expect(
			effectiveThreshold({ globalPercent: 20, realContext: 1_000_000 }),
		).toBe(200_000);
	});

	test("a per-model share is measured against that model's window", () => {
		// 50% of a 200k model is 100k, whichever the global says.
		expect(
			effectiveThreshold({
				globalPercent: 20,
				modelPercent: 50,
				realContext: 200_000,
			}),
		).toBe(100_000);
		expect(
			effectiveThreshold({
				globalPercent: 90,
				modelPercent: 10,
				realContext: 1_000_000,
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
				modelPercent: 50,
				realContext: 0,
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

	test("a model's share reads back for the model, whoever serves it", () => {
		const db = freshDb();
		setModelPercent(db, "deepseek-v4.1-flash", 50);
		expect(readModelPercent(db, "deepseek-v4.1-flash")).toBe(50);
		expect(readModelPercent(db, "other-row")).toBeUndefined();
	});

	test("the global and a model's own share are separate facts", () => {
		const db = freshDb();
		setGlobalPercent(db, 30);
		setModelPercent(db, "deepseek-v4.1-flash", 50);
		expect(readGlobalPercent(db)).toBe(30);
		expect(readModelPercent(db, "deepseek-v4.1-flash")).toBe(50);
	});

	test("a share outside 1% to 100% is refused rather than stored", () => {
		const db = freshDb();
		for (const bad of [0, -5, 101, Number.NaN]) {
			setGlobalPercent(db, bad);
			setModelPercent(db, "row", bad);
			expect(readGlobalPercent(db)).toBe(DEFAULT_PERCENT);
			expect(readModelPercent(db, "row")).toBeUndefined();
		}
	});

	test("a malformed stored value reads as unset", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO settings (key, value) VALUES ('context_percent', 'lots')",
		).run();
		expect(readGlobalPercent(db)).toBe(DEFAULT_PERCENT);
	});

	test("a share an earlier version stored per provider folds onto the model", () => {
		const db = freshDb();
		const legacy = (providerID: string, value: string) =>
			db
				.query("INSERT INTO settings (key, value) VALUES (?, ?)")
				.run(`context_percent:deepseek-v4.1-flash:${providerID}`, value);
		legacy("p1", "45");
		legacy("p2", "45");

		migrateModelPercent(db);

		expect(readModelPercent(db, "deepseek-v4.1-flash")).toBe(45);
		// The old rows go, so a second boot has nothing left to fold and cannot
		// bring a value back to life.
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'context_percent:%'",
				)
				.get()?.count,
		).toBe(0);
	});

	test("folding never overwrites a share the model already has", () => {
		const db = freshDb();
		setModelPercent(db, "deepseek-v4.1-flash", 30);
		db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
			"context_percent:deepseek-v4.1-flash:p1",
			"45",
		);

		migrateModelPercent(db);

		expect(readModelPercent(db, "deepseek-v4.1-flash")).toBe(30);
	});

	test("folding drops a legacy value no setter would have accepted", () => {
		const db = freshDb();
		db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
			"context_percent:deepseek-v4.1-flash:p1",
			"lots",
		);

		migrateModelPercent(db);

		expect(readModelPercent(db, "deepseek-v4.1-flash")).toBeUndefined();
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'context_percent:%'",
				)
				.get()?.count,
		).toBe(0);
	});
});

describe("the buffer", () => {
	test("a bare number is thousands, and a fraction reaches below one", () => {
		expect(parseBuffer("20")).toEqual({ buffer: { tokens: 20_000 }, ok: true });
		expect(parseBuffer("0.5")).toEqual({ buffer: { tokens: 500 }, ok: true });
		expect(parseBuffer("1.5")).toEqual({ buffer: { tokens: 1_500 }, ok: true });
		expect(parseBuffer("20k")).toEqual({
			buffer: { tokens: 20_000 },
			ok: true,
		});
	});

	test("a share is a slice of each model's own window", () => {
		expect(parseBuffer("10%")).toEqual({ buffer: { percent: 10 }, ok: true });
	});

	test("empty means the built-in rule", () => {
		expect(parseBuffer("")).toEqual({ buffer: undefined, ok: true });
		expect(parseBuffer("   ")).toEqual({ buffer: undefined, ok: true });
	});

	test("anything else is refused rather than stored as nothing", () => {
		// `2m` is past the declared window, and a 100% share leaves no room for
		// the compaction it is meant to make room for.
		for (const bad of ["lots", "0", "0%", "100%", "20%%", "-5", "2m"]) {
			expect(parseBuffer(bad).ok).toBe(false);
		}
	});

	test("one share suits a small model and a large one alike", () => {
		expect(compactionReserve(200_000, { percent: 10 })).toBe(20_000);
		expect(compactionReserve(1_000_000, { percent: 10 })).toBe(100_000);
	});

	test("a size is the size, unless it would swallow the window", () => {
		expect(compactionReserve(200_000, { tokens: 40_000 })).toBe(40_000);
		// A model that reports very little keeps room to hold a conversation.
		expect(compactionReserve(100_000, { tokens: 40_000 })).toBe(25_000);
	});

	test("it moves the cut, which is the whole point", () => {
		// Global 90% of a 200k model would cut at 180k; a 40k buffer at 160k.
		expect(
			effectiveThreshold({
				buffer: { tokens: 40_000 },
				globalPercent: 90,
				realContext: 200_000,
			}),
		).toBe(160_000);
	});

	test("a stored buffer reads back, and an unreadable one is the default", () => {
		const db = freshDb();
		expect(readBuffer(db)).toBeUndefined();
		expect(readBufferSpec(db)).toBeUndefined();

		setBuffer(db, "20");
		expect(readBuffer(db)).toBe("20");
		expect(readBufferSpec(db)).toEqual({ tokens: 20_000 });

		setBuffer(db, "");
		expect(readBuffer(db)).toBeUndefined();

		// A row no setter would have written must not poison the decision.
		db.query(
			"INSERT INTO settings (key, value) VALUES ('context_buffer', 'lots')",
		).run();
		expect(readBuffer(db)).toBe("lots");
		expect(readBufferSpec(db)).toBeUndefined();
	});
});
