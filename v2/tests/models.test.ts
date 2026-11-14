import { describe, expect, test } from "bun:test";
import {
	groupByBrand,
	matchModel,
	modelBrand,
	modelFamily,
	normalizeModel,
} from "../core/models";

describe("model names", () => {
	test("normalise collapses the spellings providers disagree about", () => {
		expect(normalizeModel("deepseek/deepseek-v4.1-flash")).toBe(
			"deepseek-v4.1-flash",
		);
		expect(normalizeModel("DeepSeek V4.1 Flash")).toBe("deepseek-v4.1-flash");
		expect(normalizeModel("moonshotai/Kimi-K3.1-Pro")).toBe("kimi-k3.1-pro");
		expect(normalizeModel("Kimi K3.1 Pro")).toBe("kimi-k3.1-pro");
		expect(normalizeModel("inclusionai/ling-3.1-flash:free")).toBe(
			"ling-3.1-flash",
		);
	});

	test("family drops a build tag but keeps a version", () => {
		expect(modelFamily("deepseek-v4.1-flash-1017")).toBe("deepseek-v4.1-flash");
		expect(modelFamily("DeepSeek V4.1 Flash 1017")).toBe("deepseek-v4.1-flash");
		expect(modelFamily("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		expect(modelFamily("glm-5.3")).toBe("glm-5.3");
		expect(modelFamily("claude-opus-4-8")).toBe("claude-opus-4-8");
	});
});

describe("model matching", () => {
	const candidates = [
		{ modelID: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
		{
			modelID: "deepseek/deepseek-v4.1-flash-fast",
			name: "DeepSeek V4.1 Flash Fast",
		},
		{ modelID: "moonshotai/Kimi-K3.1-Pro", name: "Kimi K3.1 Pro" },
	];

	test("an exact id outranks everything", () => {
		const match = matchModel("deepseek/deepseek-v4.1-flash-fast", candidates);
		expect(match?.model.modelID).toBe("deepseek/deepseek-v4.1-flash-fast");
		expect(match?.score).toBe(4);
	});

	test("the picker's label resolves to the provider id", () => {
		const match = matchModel("Kimi K3.1 Pro", candidates);
		expect(match?.model.modelID).toBe("moonshotai/Kimi-K3.1-Pro");
	});

	test("a build-tagged variant resolves to the untagged model", () => {
		const match = matchModel("DeepSeek V4.1 Flash 1017", candidates);
		expect(match?.model.modelID).toBe("deepseek/deepseek-v4.1-flash");
	});

	test("a model that is merely similar does not match", () => {
		expect(matchModel("DeepSeek V4.1 Flash Ultrafast", candidates)).toBe(
			undefined,
		);
	});

	test("a name shared by two families reports the tie", () => {
		const twins = [
			{ modelID: "vendor/thing-1", name: "Thing" },
			{ modelID: "vendor/thing-2", name: "Thing" },
		];
		const match = matchModel("Thing", twins);
		expect(match?.ties.length).toBe(2);
	});
});

describe("modelBrand", () => {
	test("a version suffix is dropped", () => {
		expect(modelBrand("Qwen3.7 Max")).toBe("Qwen");
		expect(modelBrand("GLM 5.3 Flash")).toBe("GLM");
	});

	test("plain brand names pass through", () => {
		expect(modelBrand("Claude Fable 5.2")).toBe("Claude");
		expect(modelBrand("DeepSeek V4.1 Flash")).toBe("DeepSeek");
		expect(modelBrand("MiMo V2.6 Flash")).toBe("MiMo");
		expect(modelBrand("Kimi K3.1 Pro")).toBe("Kimi");
	});

	test("a label that is not a brand keeps its first word", () => {
		expect(modelBrand("gpt-5")).toBe("gpt");
		expect(modelBrand("5")).toBe("5");
	});

	test("a hyphenated label groups by what precedes the dash", () => {
		expect(modelBrand("GLM-5.3")).toBe("GLM");
		expect(modelBrand("Claude-Fable-5.2")).toBe("Claude");
		expect(modelBrand("deepseek-v4.1-flash")).toBe("deepseek");
		expect(modelBrand("kimi-k3.1-pro")).toBe("kimi");
	});
});

describe("groupByBrand", () => {
	test("rows gather under their brand, groups in order", () => {
		const rows = [
			{ label: "Claude Fable 5.1" },
			{ label: "DeepSeek V4 Pro" },
			{ label: "Claude Opus 5.5" },
			{ label: "GLM-5.3" },
		];
		const grouped = groupByBrand(rows);

		expect(grouped.map(([brand]) => brand)).toEqual([
			"Claude",
			"DeepSeek",
			"GLM",
		]);
		expect(grouped[0]?.[1].map((row) => row.label)).toEqual([
			"Claude Fable 5.1",
			"Claude Opus 5.5",
		]);
	});

	test("an empty list has no groups", () => {
		expect(groupByBrand([])).toEqual([]);
	});
});
