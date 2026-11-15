import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	DEFAULT_REBALANCE_MS,
	formatDuration,
	getRebalanceAuto,
	parseDuration,
	readRebalance,
	rebalanceAfterMs,
	setRebalance,
	setRebalanceAuto,
} from "../core/rebalance";
import { migrate } from "../core/schema";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

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
