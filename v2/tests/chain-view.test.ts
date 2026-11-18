import { describe, expect, test } from "bun:test";

import { mergeChainRows, sameChain } from "../core/chain-view";
import type { Chain } from "../types";

const PACKAGE = "@opencode/ai/providers/openai-compatible";

function chain(
	key: string,
	targets: {
		context?: number;
		modelID?: string;
		providerID: string;
		state?: string;
	}[],
): Chain {
	return {
		context: 200_000,
		key,
		label: key,
		limit: "",
		package: PACKAGE,
		stored: false,
		targets: targets.map((target) => ({
			context: target.context ?? 0,
			modelID: target.modelID ?? key,
			name: target.modelID ?? key,
			providerID: target.providerID,
			resolved: target.modelID ?? key,
			state: target.state ?? "available",
		})),
	};
}

describe("a polled row list", () => {
	test("an unchanged row keeps the object the panel already rendered", () => {
		const before = [chain("a", [{ providerID: "p1" }])];
		const after = [chain("a", [{ providerID: "p1" }])];

		// Identity is what Solid's <For> keys on. A fresh object for an unchanged
		// row makes the panel throw away the DOM under it, which is what closed
		// the model picker every two seconds while somebody was choosing in it.
		expect(sameChain(before[0], after[0])).toBe(true);
		expect(mergeChainRows(before, after)[0]).toBe(before[0]);
	});

	test("a list that changed nothing is the same list, not a new one", () => {
		const before = [chain("a", [{ providerID: "p1" }])];
		const after = [chain("a", [{ providerID: "p1" }])];
		expect(mergeChainRows(before, after)).toBe(before);
	});

	test("a row whose target changed is replaced", () => {
		const before = [chain("a", [{ providerID: "p1", state: "available" }])];
		const after = [chain("a", [{ providerID: "p1", state: "limited" }])];

		expect(sameChain(before[0], after[0])).toBe(false);
		expect(mergeChainRows(before, after)[0]).toBe(after[0]);
	});

	test("a target added or removed changes the row", () => {
		const one = chain("a", [{ providerID: "p1" }]);
		const two = chain("a", [{ providerID: "p1" }, { providerID: "p2" }]);
		expect(sameChain(one, two)).toBe(false);
		expect(sameChain(two, one)).toBe(false);
	});

	test("the model actually sent is part of the row", () => {
		// `resolved` is the free spelling a free-only credential gets; a row that
		// stopped substituting must not keep showing the substituted id.
		const paid = chain("a", [{ providerID: "p1" }]);
		const free = chain("a", [{ modelID: "a-free", providerID: "p1" }]);
		expect(sameChain(paid, free)).toBe(false);
	});

	test("a row the server dropped leaves, and a new one arrives", () => {
		const before = [
			chain("a", [{ providerID: "p1" }]),
			chain("b", [{ providerID: "p1" }]),
		];
		const after = [
			chain("a", [{ providerID: "p1" }]),
			chain("c", [{ providerID: "p1" }]),
		];

		const merged = mergeChainRows(before, after);
		expect(merged.map((row) => row.key)).toEqual(["a", "c"]);
		expect(merged[0]).toBe(before[0]);
		expect(merged[1]).toBe(after[1]);
	});

	test("a reordered list follows the server's order", () => {
		const a = chain("a", [{ providerID: "p1" }]);
		const b = chain("b", [{ providerID: "p1" }]);

		const merged = mergeChainRows(
			[a, b],
			[chain("b", [{ providerID: "p1" }]), chain("a", [{ providerID: "p1" }])],
		);
		expect(merged.map((row) => row.key)).toEqual(["b", "a"]);
		expect(merged[0]).toBe(b);
		expect(merged[1]).toBe(a);
	});
});
