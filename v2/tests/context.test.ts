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
	readBufferEnforcement,
	readBufferSpec,
	readCompactPromptTokens,
	readLimit,
	readLimitSpec,
	readModelLimit,
	readModelLimitSpec,
	setBuffer,
	setBufferEnforcement,
	setLimit,
	setModelLimit,
	writeCompactPromptTokens,
} from "../core/context";
import { migrate } from "../core/schema";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

describe("where the conversation is cut", () => {
	test("the limit picks the cut, and the buffer comes off it", () => {
		// The balancer tells every model it holds 1M, so a 25% limit asks for
		// 250k. The buffer is a share of that limit, so 5% is 12.5k — raised to
		// the 20k floor — and the conversation is compacted at 230k.
		expect(
			effectiveThreshold({
				buffer: { percent: 5 },
				globalLimit: { percent: 25 },
				realContext: 1_000_000,
			}),
		).toBe(230_000);
	});

	test("the buffer is a share of the limit, not of the window", () => {
		// The reserve is 20k whatever the model holds, because the limit is the
		// same either way and 5% of it is below the floor; the window only clamps
		// what is left of it.
		expect(
			effectiveThreshold({
				buffer: { percent: 5 },
				globalLimit: { percent: 25 },
				realContext: 200_000,
			}),
		).toBe(180_000);
		// The same limit on a model that can hold all of it.
		expect(
			effectiveThreshold({
				buffer: { percent: 5 },
				globalLimit: { percent: 25 },
				realContext: 1_000_000,
			}),
		).toBe(230_000);
	});

	test("with nothing set, the limit is a fifth of the declared window", () => {
		// 20% of 1M asks for 200k; the built-in reserve is a tenth of that limit
		// or 20k, whichever is larger, so the cut lands at 180k.
		expect(effectiveThreshold({ realContext: 1_000_000 })).toBe(180_000);
		expect(
			effectiveThreshold({
				globalLimit: { percent: 20 },
				realContext: 1_000_000,
			}),
		).toBe(180_000);
		expect(DEFAULT_PERCENT).toBe(20);
	});

	test("the global share is measured against the declared window", () => {
		// 20% is a fifth of the 1M every balancer model declares, not of whatever
		// a connector really holds.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 20 },
				realContext: 500_000,
			}),
		).toBe(180_000);
	});

	test("a limit past the model's window is clamped to it first", () => {
		// 30% of the declared 1M is 300k, but this model only holds 200k, so the
		// cut starts from 200k and takes the 30k reserve off that.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 30 },
				realContext: 200_000,
			}),
		).toBe(170_000);
	});

	test("a limit given in tokens is that size, wherever it is set", () => {
		// The same number says a size for the global limit and for a model's:
		// 200 means two hundred thousand tokens either way.
		expect(
			effectiveThreshold({
				globalLimit: { tokens: 200_000 },
				realContext: 1_000_000,
			}),
		).toBe(180_000);
		expect(
			effectiveThreshold({
				globalLimit: { tokens: 200_000 },
				realContext: 200_000,
			}),
		).toBe(180_000);
		// A model that holds half of it keeps its own room, a quarter of 100k.
		expect(
			effectiveThreshold({
				globalLimit: { tokens: 200_000 },
				realContext: 100_000,
			}),
		).toBe(80_000);
	});

	test("the reserve never takes more than a quarter of what the model holds", () => {
		// The cut may not sit at the model's last token: compacting is another
		// request against the same model, and it carries the conversation with it.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 100 },
				realContext: 200_000,
			}),
		).toBe(150_000);
		// A window too small to give up 20k gives up a quarter instead, rather
		// than being left with nowhere to hold a conversation.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 100 },
				realContext: 32_000,
			}),
		).toBe(24_000);
		// A tenth of a 1M window is the larger built-in reserve: a hundred off it.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 100 },
				realContext: 1_000_000,
			}),
		).toBe(900_000);
	});

	test("a per-model limit is measured against that model's window", () => {
		// 50% of a 200k model is 100k, whichever the global says.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 20 },
				modelLimit: { percent: 50 },
				realContext: 200_000,
			}),
		).toBe(80_000);
		expect(
			effectiveThreshold({
				globalLimit: { percent: 90 },
				modelLimit: { percent: 10 },
				realContext: 1_000_000,
			}),
		).toBe(80_000);
	});

	test("a model's own size replaces the global, whichever form it takes", () => {
		expect(
			effectiveThreshold({
				globalLimit: { percent: 90 },
				modelLimit: { tokens: 50_000 },
				realContext: 200_000,
			}),
		).toBe(37_500);
	});

	test("an unknown window leaves the limit alone", () => {
		// A provider that reports no window must still be cut, not left to grow
		// until it is refused.
		expect(effectiveThreshold({ globalLimit: { percent: 20 } })).toBe(180_000);
		expect(
			effectiveThreshold({
				globalLimit: { percent: 20 },
				modelLimit: { percent: 50 },
				realContext: 0,
			}),
		).toBe(450_000);
		// A size needs no window to mean something.
		expect(effectiveThreshold({ globalLimit: { tokens: 150_000 } })).toBe(
			130_000,
		);
	});
});

describe("when the buffer is enforced", () => {
	test("`always` takes the reserve off any cut", () => {
		// The default, and what an installation predating the choice gets: a 25%
		// limit asks for 250k and the built-in reserve of a tenth comes off it.
		expect(
			effectiveThreshold({
				globalLimit: { percent: 25 },
				realContext: 1_000_000,
			}),
		).toBe(225_000);
		expect(
			effectiveThreshold({
				bufferEnforcement: "always",
				globalLimit: { percent: 25 },
				realContext: 1_000_000,
			}),
		).toBe(225_000);
	});

	test("`necessary` leaves a limit that already has room alone", () => {
		// 250k of the 1M this model holds leaves three quarters of it free, so
		// there is nothing to make room for and the limit stands alone.
		expect(
			effectiveThreshold({
				bufferEnforcement: "necessary",
				globalLimit: { percent: 25 },
				realContext: 1_000_000,
			}),
		).toBe(250_000);
	});

	test("`necessary` still keeps room where the limit has none", () => {
		// 100% of what the model holds is a cut on its last token, the one place
		// compacting cannot work from, so the reserve is kept regardless.
		expect(
			effectiveThreshold({
				bufferEnforcement: "necessary",
				globalLimit: { percent: 100 },
				realContext: 1_000_000,
			}),
		).toBe(900_000);
		// The same when the limit asks for more than a smaller model holds.
		expect(
			effectiveThreshold({
				bufferEnforcement: "necessary",
				globalLimit: { percent: 75 },
				realContext: 200_000,
			}),
		).toBe(150_000);
	});

	test("it governs a buffer the user set just as much", () => {
		expect(
			effectiveThreshold({
				buffer: { percent: 5 },
				bufferEnforcement: "necessary",
				globalLimit: { percent: 25 },
				realContext: 1_000_000,
			}),
		).toBe(250_000);
		// Asked for `always`, the same buffer cuts.
		expect(
			effectiveThreshold({
				buffer: { percent: 5 },
				bufferEnforcement: "always",
				globalLimit: { percent: 25 },
				realContext: 1_000_000,
			}),
		).toBe(230_000);
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

	test("one share gives a tenth of the cut, whatever the cut is", () => {
		expect(
			compactionReserve({
				buffer: { percent: 10 },
				ceiling: 200_000,
				limit: 200_000,
			}),
		).toBe(20_000);
		expect(
			compactionReserve({
				buffer: { percent: 10 },
				ceiling: 1_000_000,
				limit: 1_000_000,
			}),
		).toBe(100_000);
	});

	test("a size is the size, unless it would swallow the cut", () => {
		expect(
			compactionReserve({
				buffer: { tokens: 40_000 },
				ceiling: 200_000,
				limit: 200_000,
			}),
		).toBe(40_000);
		// A model that reports very little keeps room to hold a conversation.
		expect(
			compactionReserve({
				buffer: { tokens: 40_000 },
				ceiling: 100_000,
				limit: 100_000,
			}),
		).toBe(25_000);
	});

	test("a buffer set below the floor is raised to it", () => {
		// 1% of a 250k limit is 2.5k, which no longer stands: the floor is 20k
		// whatever was typed, so a compaction request always has room for its
		// own instruction without measuring that instruction every time.
		expect(
			compactionReserve({
				buffer: { percent: 1 },
				ceiling: 250_000,
				limit: 250_000,
			}),
		).toBe(20_000);
		// A 30k window cannot spare 20k, so the quarter cap decides.
		expect(
			compactionReserve({
				buffer: { percent: 1 },
				ceiling: 30_000,
				limit: 30_000,
			}),
		).toBe(7_500);
		// A size below the floor is raised the same way.
		expect(
			compactionReserve({
				buffer: { tokens: 200 },
				ceiling: 200_000,
				limit: 200_000,
			}),
		).toBe(20_000);
		// A window too small to spare the floor keeps its quarter: a cut with
		// nothing left behind it is the other way to trip the same overflow.
		expect(
			compactionReserve({
				buffer: { percent: 1 },
				ceiling: 2_000,
				limit: 2_000,
			}),
		).toBe(500);
	});

	test("the built-in rule is above the prompt, so the floor never touches it", () => {
		expect(compactionReserve({ ceiling: 100_000, limit: 100_000 })).toBe(
			20_000,
		);
	});

	test("the floor holds whatever was measured", () => {
		// The instruction the host actually sent is no longer what sets the
		// floor: 20k covers every summary measured so far, and a figure below it
		// would be the difference between a compaction and an overflow.
		expect(
			compactionReserve({
				buffer: { tokens: 500 },
				ceiling: 200_000,
				limit: 200_000,
				promptTokens: 3_000,
			}),
		).toBe(20_000);
		// And the cut a session is compacted at follows the floor, not the
		// measurement.
		expect(
			effectiveThreshold({
				buffer: { tokens: 500 },
				globalLimit: { tokens: 200_000 },
				promptTokens: 3_000,
				realContext: 200_000,
			}),
		).toBe(180_000);
	});

	test("it moves the cut, which is the whole point", () => {
		// A 90% limit asks for 900k of the declared 1M, but this model holds
		// 200k, so the cut starts from 200k and a 40k buffer comes off it.
		expect(
			effectiveThreshold({
				buffer: { tokens: 40_000 },
				globalLimit: { percent: 90 },
				realContext: 200_000,
			}),
		).toBe(160_000);
	});

	test("the enforcement choice reads back, and defaults to always", () => {
		const db = freshDb();
		expect(readBufferEnforcement(db)).toBe("always");

		setBufferEnforcement(db, "necessary");
		expect(readBufferEnforcement(db)).toBe("necessary");

		setBufferEnforcement(db, "always");
		expect(readBufferEnforcement(db)).toBe("always");

		// A row no setter would have written reads as the default, not as a
		// third state that decides nothing.
		db.query(
			"INSERT INTO settings (key, value) VALUES ('context_buffer_enforce', 'sometimes') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run();
		expect(readBufferEnforcement(db)).toBe("always");
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

describe("the measured summary prompt", () => {
	test("it starts at the figure the host's own prompt measured", () => {
		// Until a compaction has been watched, the size measured from the host's
		// source is the best available floor.
		expect(readCompactPromptTokens(freshDb())).toBe(1_000);
	});

	test("a measurement is stored as a round figure and reads back", () => {
		const db = freshDb();
		writeCompactPromptTokens(db, 1_999.6);
		expect(readCompactPromptTokens(db)).toBe(2_000);
	});

	test("a value no setter would have written falls back", () => {
		const db = freshDb();
		for (const bad of ["soon", "0", "-4"]) {
			db.query(
				"INSERT OR REPLACE INTO settings (key, value) VALUES ('compact_prompt_tokens', ?)",
			).run(bad);
			expect(readCompactPromptTokens(db)).toBe(1_000);
		}
	});

	test("a size that is not a positive number is not written", () => {
		const db = freshDb();
		writeCompactPromptTokens(db, Number.NaN);
		writeCompactPromptTokens(db, 0);
		expect(readCompactPromptTokens(db)).toBe(1_000);
	});
});
