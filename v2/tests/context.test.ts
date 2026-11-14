import { describe, expect, test } from "bun:test";
import {
	bufferFromShare,
	declaredContext,
	rowWindow,
	usableShare,
} from "../core/context";
import { parseBuffer } from "../server/compaction-config";

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

	test("the declaration is compensated however the row is sized", () => {
		// A uniform 200k row at 75% must still declare 800k. Pulling the
		// declaration back to the row's own 200k would make the host compact at
		// 50k. The declared number is a lever, not a claim about the model.
		expect(declaredContext(200_000, { kind: "percent", percent: 0.75 })).toBe(
			800_000,
		);
		expect(declaredContext(1_000_000, { kind: "percent", percent: 0.75 })).toBe(
			4_000_000,
		);
		expect(declaredContext(200_000, { kind: "tokens", tokens: 20_000 })).toBe(
			220_000,
		);
	});
});

describe("the share a window has left to use", () => {
	test("the host's reserve reads the other way round", () => {
		expect(usableShare({ kind: "percent", percent: 0.2 })).toBe("80%");
		expect(usableShare({ kind: "percent", percent: 0.75 })).toBe("25%");
		expect(usableShare({ kind: "percent", percent: 0.01 })).toBe("99%");
	});

	test("a token reserve has no share to show", () => {
		expect(usableShare({ kind: "tokens", tokens: 150_000 })).toBe("150000");
		expect(usableShare({ kind: "none" })).toBe("");
	});

	test("a typed share is stored as the reserve the host wants", () => {
		expect(bufferFromShare("80%")).toBe("20%");
		expect(bufferFromShare("80")).toBe("20%");
		expect(bufferFromShare("25%")).toBe("75%");
	});

	test("a large bare number is a token count, not a share", () => {
		expect(bufferFromShare("150000")).toBe("150000");
		expect(bufferFromShare("120")).toBe("120");
	});

	test("a share the host cannot store is refused", () => {
		// 0% reserve would compact at the window's very edge, 100% would never.
		expect(() => bufferFromShare("100%")).toThrow();
		expect(() => bufferFromShare("0%")).toThrow();
		expect(() => bufferFromShare("abc")).toThrow();
	});

	test("a share survives a round trip", () => {
		for (const reserve of ["1%", "20%", "49.5%", "99%"]) {
			expect(bufferFromShare(usableShare(parseBuffer(reserve)))).toBe(reserve);
		}
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
