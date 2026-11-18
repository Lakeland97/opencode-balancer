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
	test("a row declares every level any target offers, least to most", () => {
		const row = canonicalVariants([cline, openDesign, opencode]);

		expect(row.map((variant) => variant.id)).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"max",
		]);
	});

	test("a level named by two targets keeps the first target's settings", () => {
		const row = canonicalVariants([openDesign, cline]);
		const high = row.find((variant) => variant.id === "high");
		expect(high?.settings).toEqual({ reasoningEffort: "high" });
	});

	test("a provider that names its rungs differently still orders them", () => {
		// Not every connector uses the effort names. Declaration order is the
		// only ladder such a provider gives, so it is the one used.
		const row = canonicalVariants([
			[{ id: "default" }, { id: "thinking" }, { id: "extended" }],
		]);
		expect(row.map((variant) => variant.id)).toEqual([
			"default",
			"thinking",
			"extended",
		]);
	});

	test("no variants means no ladder, not an empty level", () => {
		expect(canonicalVariants([[], []])).toEqual([]);
	});
});

describe("sending a level to a target that named it differently", () => {
	test("a name both sides share is used as itself", () => {
		expect(mapVariant("high", openDesign)?.id).toBe("high");
		expect(mapVariant("low", cline)?.id).toBe("low");
	});

	test("three rungs map onto the bottom of a five-rung target", () => {
		// The row offers none/low/medium/high/max because cline does; open-design
		// only has low/medium/high. Its lowest is `low`, so `none` is sent there
		// and its highest is `high`, so `max` is sent there too.
		expect(mapVariant("none", openDesign)?.id).toBe("low");
		expect(mapVariant("max", openDesign)?.id).toBe("high");
		expect(mapVariant("medium", openDesign)?.id).toBe("medium");
	});

	test("a rung missing in the middle falls to the nearer neighbour", () => {
		// opencode has no `medium`: `low` is one rung away, `high` one the other
		// way. Equal distance goes to the lower rung, because overshooting a
		// thinking budget costs more than undershooting it.
		expect(mapVariant("medium", opencode)?.id).toBe("low");
	});

	test("a level the target does not have maps to the closest it does", () => {
		expect(mapVariant("xhigh", openDesign)?.id).toBe("high");
		// `minimal` sits between cline's `none` and `low`; the tie goes to the
		// lower rung, so the request spends less than it asked for, never more.
		expect(mapVariant("minimal", cline)?.id).toBe("none");
	});

	test("the target's own default is chosen when nothing was asked for", () => {
		expect(mapVariant(undefined, openDesign)).toBeUndefined();
		expect(mapVariant("high", [])).toBeUndefined();
	});
});

describe("rewriting a body for the target's rung", () => {
	test("the effort field is replaced with the target's own", () => {
		const body: Record<string, unknown> = {
			model: "deepseek-v4.1-flash",
			reasoning_effort: "max",
		};

		rewriteVariant(
			body,
			mapVariant("max", canonicalVariants([cline])),
			mapVariant("max", openDesign),
		);

		expect(body.reasoning_effort).toBe("high");
		expect(body.model).toBe("deepseek-v4.1-flash");
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

	test("the same rung on both sides leaves the body untouched", () => {
		const body: Record<string, unknown> = { reasoning_effort: "high" };
		const variant = { id: "high", settings: { reasoningEffort: "high" } };

		rewriteVariant(body, variant, variant);

		expect(body).toEqual({ reasoning_effort: "high" });
	});
});
