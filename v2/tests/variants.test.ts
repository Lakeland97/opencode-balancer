import { describe, expect, test } from "bun:test";

import {
	canonicalVariants,
	mapVariant,
	rewriteVariant,
	type Variant,
} from "../server/variants";

/** The shapes the three connectors actually returned on the same model. */
const openDesign: Variant[] = [
	{ id: "low", settings: { reasoningEffort: "low" } },
	{ id: "medium", settings: { reasoningEffort: "medium" } },
	{ id: "high", settings: { reasoningEffort: "high" } },
];
const cline: Variant[] = [
	{ id: "none", settings: { reasoningEffort: "none" } },
	{ id: "low", settings: { reasoningEffort: "low" } },
	{ id: "high", settings: { reasoningEffort: "high" } },
	{ id: "max", settings: { reasoningEffort: "max" } },
];
const opencode: Variant[] = [
	{ id: "low", settings: { reasoningEffort: "low" } },
	{ id: "high", settings: { reasoningEffort: "high" } },
	{ id: "max", settings: { reasoningEffort: "max" } },
];

describe("one thinking ladder per row", () => {
	test("a row offers three levels, whatever its targets publish", () => {
		const row = canonicalVariants([cline, openDesign, opencode]);
		expect(row.map((variant) => variant.id)).toEqual(["low", "medium", "high"]);
	});

	test("a level named by a target keeps that target's settings", () => {
		const row = canonicalVariants([openDesign, cline]);
		const high = row.find((variant) => variant.id === "high");
		expect(high?.settings).toEqual({ reasoningEffort: "high" });
	});

	test("a level no target named is declared without settings", () => {
		// The host refuses a level the row does not declare, so all three are
		// declared even when a target named only some of them.
		const row = canonicalVariants([cline]);
		expect(row.find((variant) => variant.id === "medium")).toEqual({
			id: "medium",
		});
	});

	test("a row whose targets publish no rungs still declares three", () => {
		expect(canonicalVariants([[], []]).map((variant) => variant.id)).toEqual([
			"low",
			"medium",
			"high",
		]);
	});

	test("a provider's own names never leak onto the row", () => {
		const row = canonicalVariants([
			[{ id: "default" }, { id: "thinking" }, { id: "extended" }],
		]);
		expect(row.map((variant) => variant.id)).toEqual(["low", "medium", "high"]);
	});
});

describe("sending a level to a target that named it differently", () => {
	test("a ladder already in the row's words maps one to one", () => {
		expect(mapVariant("high", openDesign)?.id).toBe("high");
		expect(mapVariant("low", cline)?.id).toBe("low");
	});

	test("a three-rung target maps one to one", () => {
		expect(mapVariant("none", openDesign)?.id).toBe("low");
		expect(mapVariant("max", openDesign)?.id).toBe("high");
		expect(mapVariant("medium", openDesign)?.id).toBe("medium");
	});

	test("a five-rung target answers from its tail", () => {
		// The target's last three rungs are what the row's three mean: its third
		// rung is `low`, the fourth `medium`, the fifth `high`.
		const five: Variant[] = [
			{ id: "none" },
			{ id: "minimal" },
			{ id: "low" },
			{ id: "medium" },
			{ id: "high" },
		];
		expect(mapVariant("low", five)?.id).toBe("low");
		expect(mapVariant("medium", five)?.id).toBe("medium");
		expect(mapVariant("high", five)?.id).toBe("high");
	});

	test("a target between the row's names maps onto its last three rungs", () => {
		// opencode has low/high/max. The tail is the whole ladder: low is its
		// first rung, medium its second, high its third.
		expect(mapVariant("low", opencode)?.id).toBe("low");
		expect(mapVariant("medium", opencode)?.id).toBe("high");
		expect(mapVariant("high", opencode)?.id).toBe("max");
	});

	test("a target with fewer rungs never overshoots the request", () => {
		// A two-rung target answers `low` and `medium` with its first rung and
		// `high` with its last.
		const two: Variant[] = [{ id: "low" }, { id: "high" }];
		expect(mapVariant("low", two)?.id).toBe("low");
		expect(mapVariant("medium", two)?.id).toBe("low");
		expect(mapVariant("high", two)?.id).toBe("high");
	});

	test("a target that names no rung is sent none", () => {
		expect(mapVariant("high", [])).toBeUndefined();
		expect(mapVariant(undefined, openDesign)).toBeUndefined();
	});
});

describe("rewriting a body for the target's rung", () => {
	test("the effort field is replaced with the target's own", () => {
		const body: Record<string, unknown> = {
			model: "deepseek-v4.1-flash",
			reasoning_effort: "high",
		};

		rewriteVariant(
			body,
			canonicalVariants([openDesign]).find((variant) => variant.id === "high"),
			// cline's tail is `max`, which is what the row's `high` means there.
			mapVariant("high", cline),
		);

		expect(body.reasoning_effort).toBe("max");
		expect(body.model).toBe("deepseek-v4.1-flash");
	});

	test("a mapped level is written even when the row carried no settings", () => {
		// opencode names no `medium`, so the row declares one without settings.
		// The target that receives it does have a middle rung, and the level has
		// to travel with the request or the mapping was only a label.
		const body: Record<string, unknown> = { model: "deepseek-v4.1-flash" };
		const row = canonicalVariants([opencode]);

		rewriteVariant(
			body,
			row.find((variant) => variant.id === "medium"),
			mapVariant("medium", openDesign),
		);

		expect(body.reasoning_effort).toBe("medium");
	});

	test("a field only the row's rung set is removed", () => {
		// cline declares `max`; open-design has no such rung, and leaving the
		// field behind would ask it for an effort it never advertised.
		const body: Record<string, unknown> = { reasoning_effort: "max" };

		rewriteVariant(
			body,
			{ id: "max", settings: { reasoningEffort: "max" } },
			{
				id: "high",
				settings: {},
			},
		);

		expect("reasoning_effort" in body).toBe(false);
	});

	test("a responses-style body nests the effort", () => {
		const body: Record<string, unknown> = { reasoning: { effort: "max" } };

		rewriteVariant(
			body,
			{ id: "max", settings: { reasoningEffort: "max" } },
			{
				id: "high",
				settings: { reasoningEffort: "high" },
			},
		);

		expect(body.reasoning).toEqual({ effort: "high" });
	});

	test("a target that names no rung gets no level at all", () => {
		// The provider never advertised an effort, so leaving the row's effort in
		// the body would ask it for one it does not have.
		const body: Record<string, unknown> = { reasoning_effort: "high" };

		rewriteVariant(
			body,
			{ id: "high", settings: { reasoningEffort: "high" } },
			undefined,
		);

		expect(body).toEqual({});
	});

	test("the same rung on both sides leaves the body untouched", () => {
		const body: Record<string, unknown> = { reasoning_effort: "high" };
		const variant = { id: "high", settings: { reasoningEffort: "high" } };

		rewriteVariant(body, variant, variant);

		expect(body).toEqual({ reasoning_effort: "high" });
	});
});
