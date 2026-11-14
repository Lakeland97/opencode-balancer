import { describe, expect, test } from "bun:test";
import {
	type CompactionBuffer,
	reserveLabel,
	rowWindow,
	targetShare,
	tripContext,
} from "../core/context";

const percent = (value: number): CompactionBuffer => ({
	kind: "percent",
	percent: value,
});

describe("where the host trips", () => {
	test("the trip is the window less the reserve", () => {
		// The host keeps `metadata.buffer` free of whatever window it is told,
		// so the file's reserve is the only thing between the window and the
		// compaction trigger.
		expect(tripContext(1_000_000, percent(0.51))).toBe(490_000);
		expect(tripContext(1_000_000, percent(0.25))).toBe(750_000);
		expect(tripContext(200_000, percent(0.51))).toBe(98_000);
	});

	test("no reserve trips at the whole window", () => {
		expect(tripContext(1_000_000, { kind: "none" })).toBe(1_000_000);
	});

	test("a token reserve is taken off the window", () => {
		expect(tripContext(1_000_000, { kind: "tokens", tokens: 150_000 })).toBe(
			850_000,
		);
	});

	test("a reserve larger than the window trips immediately", () => {
		expect(tripContext(100_000, { kind: "tokens", tokens: 150_000 })).toBe(0);
		// And a window of nothing never trips above nothing.
		expect(tripContext(0, percent(0.5))).toBe(0);
	});

	test("a nonsensical reserve is clamped, not trusted", () => {
		expect(tripContext(1_000_000, percent(-1))).toBe(1_000_000);
		expect(tripContext(1_000_000, percent(1))).toBeLessThan(11_000);
		expect(tripContext(1_000_000, percent(1))).toBeGreaterThan(9_000);
		expect(tripContext(1_000_000, percent(Number.NaN))).toBe(1_000_000);
	});
});

describe("the share the panel edits", () => {
	test("it is the remaining part of the window", () => {
		expect(targetShare(percent(0.51))).toBeCloseTo(0.49, 5);
		expect(targetShare(percent(0.25))).toBeCloseTo(0.75, 5);
	});

	test("a token reserve or none has no share to divide", () => {
		expect(targetShare({ kind: "tokens", tokens: 150_000 })).toBe(1);
		expect(targetShare({ kind: "none" })).toBe(1);
	});

	test("the file and the panel are the same fact, twice", () => {
		// The invariant that replaces the old compensation arithmetic: the panel
		// writes `100 − share` as the reserve, so the trip is the share.
		for (const share of [0.05, 0.25, 0.49, 0.5, 0.75, 0.99]) {
			const buffer = percent(1 - share);
			const trip = tripContext(1_000_000, buffer);
			expect(trip / 1_000_000).toBeCloseTo(share, 3);
			expect(100 - Math.round(targetShare(buffer) * 100)).toBeCloseTo(
				Math.round((1 - share) * 100),
				0,
			);
		}
	});
});

describe("the reserve label", () => {
	test("reads as the part kept free", () => {
		expect(reserveLabel(percent(0.25))).toBe("25%");
		expect(reserveLabel(percent(0.51))).toBe("51%");
		expect(reserveLabel(percent(0.495))).toBe("49.5%");
	});

	test("a token reserve says so", () => {
		expect(reserveLabel({ kind: "tokens", tokens: 150_000 })).toBe(
			"150000 tokens",
		);
	});

	test("no reserve is named as such", () => {
		expect(reserveLabel({ kind: "none" })).toBe("none");
	});
});

describe("row window", () => {
	test("the smallest target wins", () => {
		expect(rowWindow([{ context: 1_000_000 }, { context: 200_000 }])).toEqual({
			ceiling: 1_000_000,
			context: 200_000,
			output: 0,
		});
	});

	test("output is the smallest output limit", () => {
		expect(
			rowWindow([
				{ context: 200_000, output: 32_000 },
				{ context: 1_000_000, output: 384_000 },
			]),
		).toEqual({ ceiling: 1_000_000, context: 200_000, output: 32_000 });
	});

	test("targets without limits are ignored", () => {
		expect(rowWindow([{}, { context: 200_000 }])).toEqual({
			ceiling: 200_000,
			context: 200_000,
			output: 0,
		});
		expect(rowWindow([{}])).toBeUndefined();
	});
});
