import { describe, expect, test } from "bun:test";

import { modelBrand } from "../core/models";

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
});
