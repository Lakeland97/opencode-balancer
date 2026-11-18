import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
	DEFAULT_REBALANCE_MS,
	formatDuration,
	formatRemaining,
	formatSpan,
	getRebalanceAuto,
	parseDuration,
	readRebalance,
	rebalanceAfterMs,
	rebalanceWindowMs,
	setRebalance,
	setRebalanceAuto,
} from "../core/rebalance";
import { migrate } from "../core/schema";
import { nextRebalanceAt } from "../server/hooks";
import { noteServed, resetRouteMemory } from "../server/route-memory";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

// The balance is the client's and outlives a case, so each test starts from an
// untouched order rather than inheriting the previous one's trails.
beforeEach(() => {
	resetRouteMemory();
});

describe("how long a session may sit idle", () => {
	test("a number and a unit is a duration in any of the units", () => {
		expect(parseDuration("5h")).toEqual({ ms: 5 * 3_600_000, ok: true });
		expect(parseDuration("90m")).toEqual({ ms: 90 * 60_000, ok: true });
		expect(parseDuration("45s")).toEqual({ ms: 45_000, ok: true });
		expect(parseDuration("2d")).toEqual({ ms: 2 * 86_400_000, ok: true });
	});

	test("units compose, which is how a window gets written honestly", () => {
		// "1d 2h" is 26h; the field must read back the same length it was given,
		// not collapse to a rounded single unit.
		expect(parseDuration("1d 2h")).toEqual({ ms: 26 * 3_600_000, ok: true });
		expect(parseDuration(" 1d,  30m ")).toEqual({
			ms: 24 * 3_600_000 + 30 * 60_000,
			ok: true,
		});
	});

	test("zero, never and off switch the window off", () => {
		for (const text of ["0", "never", "off", "OFF", " 0 "]) {
			expect(parseDuration(text)).toEqual({ ms: 0, ok: true });
		}
	});

	test("empty is the built-in default, not zero", () => {
		// A field left blank keeps the window; treating it as "0" would silently
		// switch off the thing the field exists to configure.
		expect(parseDuration("")).toEqual({ ok: true });
		expect(parseDuration("   ")).toEqual({ ok: true });
	});

	test("a bare number is refused, because it cannot be told from the neighbours", () => {
		// The limit and buffer fields read a bare number as thousands of tokens,
		// so "5" here would be five hours or five seconds with no way to say.
		const parsed = parseDuration("5");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain("90m");
	});

	test("a unit that is not a duration is refused with the grammar to use", () => {
		for (const text of ["5 hours", "5x", "h5", "five"]) {
			const parsed = parseDuration(text);
			expect(parsed.ok).toBe(false);
		}
	});

	test("a length reads back in the largest unit that stays whole", () => {
		expect(formatDuration(5 * 3_600_000)).toBe("5h");
		expect(formatDuration(90 * 60_000)).toBe("90m");
		expect(formatDuration(26 * 3_600_000)).toBe("26h");
		expect(formatDuration(2 * 86_400_000)).toBe("2d");
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(0)).toBe("never");
	});

	test("the countdown is the soonest row to lapse, not the window", () => {
		const db = freshDb();
		const start = 1_000_000;
		// Two rows balanced at different moments: one answered a minute ago, one
		// two hours ago. The first to lapse is the one that answered a minute
		// ago, since the window runs from the last routed request.
		noteServed(
			db,
			"older",
			{ modelID: "older", providerID: "p1" },
			start - 2 * HOUR,
		);
		noteServed(
			db,
			"newer",
			{ modelID: "newer", providerID: "p2" },
			start - MINUTE,
		);

		expect(nextRebalanceAt(db, start)).toBe(start - MINUTE + 5 * HOUR);
	});

	test("nothing counting down when the switch is off", () => {
		const db = freshDb();
		setRebalanceAuto(db, false);
		noteServed(db, "row", { modelID: "row", providerID: "p1" }, 1_000_000);

		expect(nextRebalanceAt(db, 1_000_000)).toBeUndefined();
	});

	test("nothing counting down before anything has been routed", () => {
		expect(nextRebalanceAt(freshDb(), 1_000_000)).toBeUndefined();
	});

	test("a trail already past its window is stale, not pending", () => {
		const db = freshDb();
		const start = 1_000_000;
		noteServed(
			db,
			"row",
			{ modelID: "row", providerID: "p1" },
			start - 6 * HOUR,
		);

		expect(nextRebalanceAt(db, start)).toBeUndefined();
	});

	test("the note beside the field says how long is left", () => {
		// The field keeps what was typed (`90m` is still `90m`); the note says
		// how long until the balance starts over, which is what a person is
		// actually asking the control.
		expect(formatSpan(90 * 60_000)).toBe("1h 30m");
		expect(formatSpan(5 * 3_600_000)).toBe("5h");
		expect(formatSpan(45 * 60_000)).toBe("45m");
		expect(formatSpan(26 * 3_600_000)).toBe("26h");
		expect(formatSpan(59.5 * 60_000)).toBe("1h");
		expect(formatSpan(0)).toBe("never");
		// A remainder inside the last minute reads as "about to", not "0m".
		expect(formatRemaining(30_000)).toBe("<1m");
		expect(formatRemaining(4 * 3_600_000 + 12 * 60_000)).toBe("4h 12m");
		// Nothing counting down says nothing at all.
		expect(formatRemaining(0)).toBe("");
	});

	test("the note follows the switch and an unreadable value, as routing does", () => {
		// Off is "never", whatever length sits beside it, because that is the
		// window routing applies.
		expect(rebalanceWindowMs(false, "5h")).toBe(0);
		expect(rebalanceWindowMs(false, "junk")).toBe(0);
		// On with nothing typed is the built-in default.
		expect(rebalanceWindowMs(true, undefined)).toBe(DEFAULT_REBALANCE_MS);
		expect(rebalanceWindowMs(true, "")).toBe(DEFAULT_REBALANCE_MS);
		// On with a custom length is that length.
		expect(rebalanceWindowMs(true, "90m")).toBe(90 * 60_000);
		// A typo is the default, matching `rebalanceAfterMs`.
		expect(rebalanceWindowMs(true, "2 hors")).toBe(DEFAULT_REBALANCE_MS);
	});
});

describe("the stored window", () => {
	test("it round-trips as the user typed it", () => {
		const db = freshDb();
		expect(readRebalance(db)).toBeUndefined();
		setRebalance(db, "1d 2h");
		expect(readRebalance(db)).toBe("1d 2h");
		setRebalance(db, "90m");
		expect(readRebalance(db)).toBe("90m");
	});

	test("unset is the built-in five hours", () => {
		expect(rebalanceAfterMs(freshDb())).toBe(DEFAULT_REBALANCE_MS);
		expect(DEFAULT_REBALANCE_MS).toBe(5 * 3_600_000);
	});

	test("zero is the window switched off", () => {
		const db = freshDb();
		setRebalance(db, "0");
		expect(rebalanceAfterMs(db)).toBe(0);
	});

	test("a custom window is read back in milliseconds", () => {
		const db = freshDb();
		setRebalance(db, "2h");
		expect(rebalanceAfterMs(db)).toBe(2 * 3_600_000);
	});

	test("a typo falls back to the default, never to never", () => {
		// A stray character must not pin a session to one trail for good; the
		// safe failure is the window as it was before anyone typed anything.
		const db = freshDb();
		setRebalance(db, "2 hors");
		expect(rebalanceAfterMs(db)).toBe(DEFAULT_REBALANCE_MS);
	});
});

describe("the switch that turns the window off", () => {
	test("it reads as on until it is turned off", () => {
		const db = freshDb();
		expect(getRebalanceAuto(db)).toBe(true);
		setRebalanceAuto(db, false);
		expect(getRebalanceAuto(db)).toBe(false);
		setRebalanceAuto(db, true);
		expect(getRebalanceAuto(db)).toBe(true);
	});

	test("off is zero however long the field says", () => {
		const db = freshDb();
		setRebalance(db, "2h");
		expect(rebalanceAfterMs(db)).toBe(2 * 3_600_000);
		setRebalanceAuto(db, false);
		expect(rebalanceAfterMs(db)).toBe(0);
		// The length is kept, so turning the switch back on restores the window
		// the user set rather than a default nobody chose.
		setRebalanceAuto(db, true);
		expect(rebalanceAfterMs(db)).toBe(2 * 3_600_000);
	});

	test("a stored zero is off once the switch is on again", () => {
		// The RPC clears a zero before enabling, but a settings table edited by
		// hand must not be able to read as on and behave as off.
		const db = freshDb();
		setRebalance(db, "0");
		setRebalanceAuto(db, true);
		expect(rebalanceAfterMs(db)).toBe(0);
	});
});
