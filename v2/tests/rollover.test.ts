import { describe, expect, test } from "bun:test";

import { formatRollover, parseRollover } from "../core/rollover";

/** A local reference instant, so clock-time cases are the reader's own clock. */
const local = (
	year: number,
	month: number,
	day: number,
	hour = 9,
	minute = 0,
) => new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("the instant a provider names for its refill", () => {
	test("a relative window is added to the moment the failure arrived", () => {
		const at = local(2026, 11, 15);
		// This is the shape the log actually carried for a long quota.
		expect(parseRollover("usage limit reached; resets in 12d 23h", at)).toBe(
			at + 12 * DAY + 23 * HOUR,
		);
	});

	test("units spelled out read the same as the compact ones", () => {
		const at = local(2026, 11, 15);
		expect(parseRollover("rate limited. try again in 30 seconds", at)).toBe(
			at + 30_000,
		);
		expect(parseRollover("resets in 5 hours", at)).toBe(at + 5 * HOUR);
		expect(parseRollover("available after 2 hrs", at)).toBe(at + 2 * HOUR);
		expect(parseRollover("refill in 90 minutes", at)).toBe(at + 90 * MINUTE);
	});

	test("tokens run on from each other, so a later number is not gathered up", () => {
		const at = local(2026, 11, 15);
		// The far-away `23h` belongs to another clause and must not be added.
		expect(parseRollover("resets in 12d, and 23h later it expires", at)).toBe(
			at + 12 * DAY,
		);
	});

	test("an absolute instant is taken as written", () => {
		const at = Date.UTC(2026, 10, 14, 10, 0, 0);
		const said = "quota exhausted; resets at 2026-11-14T14:21:16.768Z";
		expect(parseRollover(said, at)).toBe(
			Date.UTC(2026, 10, 14, 14, 21, 16, 768),
		);
	});

	test("a written instant beats an amount said beside it", () => {
		const at = Date.UTC(2026, 10, 14, 10, 0, 0);
		const said =
			"resets at 2026-11-14T14:21:16.768Z (in 4h for other plans)".replace(
				"4h",
				"9h",
			);
		expect(parseRollover(said, at)).toBe(
			Date.UTC(2026, 10, 14, 14, 21, 16, 768),
		);
	});

	test("a clock time is today, or tomorrow once today's has gone", () => {
		// The wording the keyword list was born from: a time with no date, in the
		// reader's own clock.
		const morning = local(2026, 11, 15, 9, 0);
		expect(parseRollover("They reset at 11:27 AM.", morning)).toBe(
			local(2026, 11, 15, 11, 27),
		);

		const evening = local(2026, 11, 15, 20, 0);
		expect(parseRollover("They reset at 11:27 AM.", evening)).toBe(
			local(2026, 11, 16, 11, 27),
		);
	});

	test("an afternoon clock time and both twelves read as the clock does", () => {
		const at = local(2026, 11, 15, 9, 0);
		expect(parseRollover("resets at 4:21 PM", at)).toBe(
			local(2026, 11, 15, 16, 21),
		);
		expect(parseRollover("resets at 12 PM", at)).toBe(
			local(2026, 11, 15, 12, 0),
		);
		// Midnight: the hour after it is already past, so it lands on the next day.
		expect(parseRollover("resets at 12 AM", at)).toBe(
			local(2026, 11, 16, 0, 0),
		);
	});

	test("a twenty-four-hour clock time reads without a marker", () => {
		const at = local(2026, 11, 15, 9, 0);
		expect(parseRollover("resets at 14:21", at)).toBe(
			local(2026, 11, 15, 14, 21),
		);
	});
});

describe("what the parser must refuse to read", () => {
	const at = local(2026, 11, 15);

	test("a provider that said nothing about a refill says nothing", () => {
		for (const said of [
			"HTTP 429 Too Many Requests",
			"insufficient balance",
			"you have exhausted your credits for this billing period",
			"",
			"   ",
		]) {
			expect(parseRollover(said, at)).toBeUndefined();
		}
	});

	test("a timestamp that belongs to something else is not a refill", () => {
		// Quota wording after the instant, not before it: this is a log line, not
		// a promise, and reading it would put a date on the row with nothing behind
		// it.
		expect(
			parseRollover(
				"request 2026-11-14T14:21:16.768Z failed: quota exhausted",
				at,
			),
		).toBeUndefined();
	});

	test("a refill already in the past is not a refill", () => {
		expect(
			parseRollover("resets at 2026-11-01T00:00:00.000Z", at),
		).toBeUndefined();
	});

	test("a time that cannot be meant is refused rather than shown", () => {
		// A year out is not a quota window, and 25:00 is not a clock.
		expect(parseRollover("resets in 400d", at)).toBeUndefined();
		expect(parseRollover("resets at 25:00", at)).toBeUndefined();
		expect(parseRollover("resets at 14:99", at)).toBeUndefined();
	});
});

describe("how a refill reads on a line of text", () => {
	const noon = local(2026, 11, 15, 12, 0);

	test("a clock while it is today", () => {
		expect(formatRollover(local(2026, 11, 15, 14, 21), noon)).toBe("14:21");
		expect(formatRollover(local(2026, 11, 15, 9, 5), noon)).toBe("09:05");
	});

	test("a date once it is not, and a year only when it differs", () => {
		expect(formatRollover(local(2026, 11, 26, 14, 21), noon)).toBe(
			"Nov 26 14:21",
		);
		expect(formatRollover(local(2027, 1, 3, 0, 0), noon)).toBe(
			"Jan 3 2027 00:00",
		);
	});
});
