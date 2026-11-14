import { describe, expect, test } from "bun:test";
import { declaredContext, rowWindow } from "../core/context";

describe("declared context", () => {
	test("a percent buffer is compensated away", () => {
		expect(declaredContext(200_000, { kind: "percent", percent: 0.75 })).toBe(
			800_000,
		);
	});

	test("a buffer just under 100% cannot divide by zero", () => {
		expect(
			declaredContext(200_000, { kind: "percent", percent: 0.999 }),
		).toBeGreaterThan(0);
		expect(
			Number.isFinite(declaredContext(1000, { kind: "percent", percent: 1 })),
		).toBe(true);
	});

	test("an integer buffer is added, not divided", () => {
		expect(declaredContext(200_000, { kind: "tokens", tokens: 20_000 })).toBe(
			220_000,
		);
	});

	test("no buffer leaves the window alone", () => {
		expect(declaredContext(200_000, { kind: "none" })).toBe(200_000);
	});
});

describe("row window", () => {
	test("the smallest target wins", () => {
		expect(rowWindow([{ context: 1_000_000 }, { context: 200_000 }])).toEqual({
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
		).toEqual({ context: 200_000, output: 32_000 });
	});

	test("targets without limits are ignored", () => {
		expect(rowWindow([{}, { context: 200_000 }])).toEqual({
			context: 200_000,
			output: 0,
		});
		expect(rowWindow([{}])).toBeUndefined();
	});
});
