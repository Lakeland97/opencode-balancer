import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	compactionReserve,
	DEFAULT_PERCENT,
	effectiveThreshold,
	migrateLimits,
	parseBuffer,
	parseLimit,
	readBuffer,
	readBufferSpec,
	readLimit,
	readLimitSpec,
	readModelLimit,
	readModelLimitSpec,
	setBuffer,
	setLimit,
	setModelLimit,
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
			effectiveThreshold({
				globalLimit: { percent: 20 },
				realContext: 1_000_000,
			}),
		).toBe(200_000);
	});

	test("a share past the model's own window is clamped below it", () => {
		// 30% of the declared 1M is 300k, but this model only holds 200k, and the
		// cut keeps a reserve free, so it lands at 180k.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 30 },
				realContext: 200_000,
			}),
		).toBe(180_000);
	});

	test("a limit given in tokens is that size, wherever it is set", () => {
		// The same number says a size for the global limit and for a model's:
		// 200 means two hundred thousand tokens either way.
		expect(
			effectiveThreshold({
				globalLimit: { tokens: 200_000 },
				realContext: 1_000_000,
			}),
		).toBe(200_000);
		// A model that holds less still keeps the room the compaction needs.
		expect(
			effectiveThreshold({
				globalLimit: { tokens: 200_000 },
				realContext: 100_000,
			}),
		).toBe(80_000);
	});

	test("the ceiling leaves the compaction its own room", () => {
		// The cut may not sit at the model's last token: compacting is another
		// request against the same model, and it carries the conversation with it.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 100 },
				realContext: 200_000,
			}),
		).toBe(180_000);
		// A tenth of a 1M window is the larger reserve, so the cut stops at 900k.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 100 },
				realContext: 1_000_000,
			}),
		).toBe(900_000);
		// A window too small to give up 20k gives up a quarter instead, rather
		// than being left with nowhere to hold a conversation.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 100 },
				realContext: 32_000,
			}),
		).toBe(24_000);
		// A share that already lands below the ceiling is untouched by it.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 20 },
				realContext: 1_000_000,
			}),
		).toBe(200_000);
	});

	test("a per-model limit is measured against that model's window", () => {
		// 50% of a 200k model is 100k, whichever the global says.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 20 },
				modelLimit: { percent: 50 },
				realContext: 200_000,
			}),
		).toBe(100_000);
		expect(
			effectiveThreshold({
				globalLimit: { percent: 90 },
				modelLimit: { percent: 10 },
				realContext: 1_000_000,
			}),
		).toBe(100_000);
	});

	test("a model's own size replaces the global, whichever form it takes", () => {
		expect(
			effectiveThreshold({
				globalLimit: { percent: 90 },
				modelLimit: { tokens: 50_000 },
				realContext: 200_000,
			}),
		).toBe(50_000);
	});

	test("an unknown window leaves the limit alone", () => {
		// A provider that reports no window must still be cut, not left to grow
		// until it is refused.
		expect(effectiveThreshold({ globalLimit: { percent: 20 } })).toBe(200_000);
		expect(
			effectiveThreshold({
				globalLimit: { percent: 20 },
				modelLimit: { percent: 50 },
				realContext: 0,
			}),
		).toBe(500_000);
		// A size needs no window to mean something.
		expect(effectiveThreshold({ globalLimit: { tokens: 150_000 } })).toBe(
			150_000,
		);
	});

	test("with nothing set, the cut is a fifth of the declared window", () => {
		expect(effectiveThreshold({ realContext: 1_000_000 })).toBe(200_000);
		expect(DEFAULT_PERCENT).toBe(20);
	});
});

describe("the stored limits", () => {
	test("the global limit reads as its default until it is set", () => {
		const db = freshDb();
		expect(readLimit(db)).toBeUndefined();
		expect(readLimitSpec(db)).toBeUndefined();
	});

	test("a set limit survives a reload and clearing restores the default", () => {
		const db = freshDb();

		setLimit(db, "35%");
		expect(readLimit(db)).toBe("35%");
		expect(readLimitSpec(db)).toEqual({ percent: 35 });

		// The same field takes a size, kept as typed so the panel reads it back.
		setLimit(db, "200");
		expect(readLimit(db)).toBe("200");
		expect(readLimitSpec(db)).toEqual({ tokens: 200_000 });

		setLimit(db, "");
		expect(readLimit(db)).toBeUndefined();
		expect(readLimitSpec(db)).toBeUndefined();
	});

	test("a model's limit reads back for the model, whoever serves it", () => {
		const db = freshDb();
		setModelLimit(db, "deepseek-v4.1-flash", "50%");
		expect(readModelLimitSpec(db, "deepseek-v4.1-flash")).toEqual({
			percent: 50,
		});
		expect(readModelLimit(db, "deepseek-v4.1-flash")).toBe("50%");
		expect(readModelLimitSpec(db, "other-row")).toBeUndefined();
	});

	test("the global and a model's own limit are separate facts", () => {
		const db = freshDb();
		setLimit(db, "30%");
		setModelLimit(db, "deepseek-v4.1-flash", "50%");
		expect(readLimitSpec(db)).toEqual({ percent: 30 });
		expect(readModelLimitSpec(db, "deepseek-v4.1-flash")).toEqual({
			percent: 50,
		});
	});

	test("a malformed stored value reads as unset, not as a number", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO settings (key, value) VALUES ('context_limit', 'lots')",
		).run();
		// The text is what the field shows, but it decides nothing.
		expect(readLimit(db)).toBe("lots");
		expect(readLimitSpec(db)).toBeUndefined();
	});
});

describe("folding an earlier version's shares onto the limit", () => {
	test("a global share stored as a bare number still means the share", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO settings (key, value) VALUES ('context_percent', '25')",
		).run();

		migrateLimits(db);

		// Without the `%` the old number would now read as twenty-five thousand
		// tokens, which is a different instruction entirely.
		expect(readLimitSpec(db)).toEqual({ percent: 25 });
		expect(readLimit(db)).toBe("25%");
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM settings WHERE key = 'context_percent'",
				)
				.get()?.count,
		).toBe(0);
	});

	test("a model's bare share moves to the model's limit, still a share", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO settings (key, value) VALUES ('model_percent:deepseek-v4.1-flash', '30')",
		).run();

		migrateLimits(db);

		expect(readModelLimitSpec(db, "deepseek-v4.1-flash")).toEqual({
			percent: 30,
		});
	});

	test("a share an earlier version stored per provider folds onto the model", () => {
		const db = freshDb();
		const legacy = (providerID: string, value: string) =>
			db
				.query("INSERT INTO settings (key, value) VALUES (?, ?)")
				.run(`context_percent:deepseek-v4.1-flash:${providerID}`, value);
		legacy("p1", "45");
		legacy("p2", "45");

		migrateLimits(db);

		expect(readModelLimitSpec(db, "deepseek-v4.1-flash")).toEqual({
			percent: 45,
		});
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

	test("migration never overwrites a limit already set", () => {
		const db = freshDb();
		setLimit(db, "10%");
		setModelLimit(db, "deepseek-v4.1-flash", "30%");
		db.query(
			"INSERT INTO settings (key, value) VALUES ('context_percent', '25')",
		).run();
		db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
			"context_percent:deepseek-v4.1-flash:p1",
			"45",
		);

		migrateLimits(db);

		expect(readLimitSpec(db)).toEqual({ percent: 10 });
		expect(readModelLimitSpec(db, "deepseek-v4.1-flash")).toEqual({
			percent: 30,
		});
	});

	test("folding drops a legacy value no setter would have accepted", () => {
		const db = freshDb();
		db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
			"context_percent:deepseek-v4.1-flash:p1",
			"lots",
		);

		migrateLimits(db);

		expect(readModelLimitSpec(db, "deepseek-v4.1-flash")).toBeUndefined();
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'context_percent:%'",
				)
				.get()?.count,
		).toBe(0);
	});
});

describe("the limit's grammar", () => {
	test("a bare number is thousands, so 200 is two hundred thousand", () => {
		expect(parseLimit("200")).toEqual({
			ok: true,
			size: { tokens: 200_000 },
		});
		expect(parseLimit("0.5")).toEqual({ ok: true, size: { tokens: 500 } });
		expect(parseLimit("200k")).toEqual({
			ok: true,
			size: { tokens: 200_000 },
		});
	});

	test("a share is kept as a share, so one number suits every model", () => {
		expect(parseLimit("10%")).toEqual({ ok: true, size: { percent: 10 } });
	});

	test("empty means the default", () => {
		expect(parseLimit("")).toEqual({ ok: true, size: undefined });
		expect(parseLimit("   ")).toEqual({ ok: true, size: undefined });
	});

	test("anything else is refused rather than stored as nothing", () => {
		// `2m` is past the declared window, and a 100% share leaves no room for
		// the compaction it is meant to make room for.
		for (const bad of ["lots", "0", "0%", "100%", "20%%", "-5", "2m"]) {
			expect(parseLimit(bad).ok).toBe(false);
		}
	});
});

describe("the buffer", () => {
	test("a bare number is thousands, and a fraction reaches below one", () => {
		expect(parseBuffer("20")).toEqual({ ok: true, size: { tokens: 20_000 } });
		expect(parseBuffer("0.5")).toEqual({ ok: true, size: { tokens: 500 } });
		expect(parseBuffer("1.5")).toEqual({ ok: true, size: { tokens: 1_500 } });
		expect(parseBuffer("20k")).toEqual({
			ok: true,
			size: { tokens: 20_000 },
		});
	});

	test("a share is a slice of each model's own window", () => {
		expect(parseBuffer("10%")).toEqual({ ok: true, size: { percent: 10 } });
	});

	test("empty means the built-in rule", () => {
		expect(parseBuffer("")).toEqual({ ok: true, size: undefined });
		expect(parseBuffer("   ")).toEqual({ ok: true, size: undefined });
	});

	test("anything else is refused rather than stored as nothing", () => {
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
				globalLimit: { percent: 90 },
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
