import { describe, expect, test } from "bun:test";
import { matchModel, modelFamily, normalizeModel } from "../core/models";

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
