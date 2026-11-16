import { describe, expect, test } from "bun:test";
import {
	allCollapsed,
	providerEntries,
	rowNote,
	visibleChains,
} from "../tui/rows";
import type { Account, Chain, Provider } from "../types";

const PACKAGE = "@opencode/ai/providers/openai-compatible";

function account(providerID: string, alias: string): Account {
	return {
		active: true,
		alias,
		failures: 0,
		inUse: false,
		lastUsedAt: 0,
		limited: false,
		limitedReason: "",
		limitedUntil: 0,
		providerID,
	};
}

function provider(providerID: string): Provider {
	return {
		alias: "a",
		enabled: true,
		freeOnly: false,
		name: `Provider ${providerID}`,
		position: 0,
		providerID,
	};
}

function chain(key: string, stored: boolean, targets: number): Chain {
	return {
		key,
		label: key,
		limit: "",
		package: PACKAGE,
		stored,
		targets: Array.from({ length: targets }, (_, index) => ({
			modelID: key,
			providerID: `p${index + 1}`,
			resolved: key,
			state: "available",
		})),
	};
}

describe("derived rows", () => {
	test("providers are listed in order with their account", () => {
		const entries = providerEntries(
			[account("p1", "a"), account("p2", "a")],
			[provider("p1"), provider("p2")],
		);
		expect(entries.map((row) => row.entry.providerID)).toEqual(["p1", "p2"]);
		expect(entries[0].account?.alias).toBe("a");
	});
	test("only stored or multi-target rows are visible", () => {
		expect(
			visibleChains([
				chain("one", false, 1),
				chain("two", false, 2),
				chain("three", true, 1),
			]).map((row) => row.key),
		).toEqual(["three", "two"]);
	});
	test("allCollapsed includes the models section", () => {
		const rows = [chain("a", true, 1)];
		expect(
			allCollapsed({
				chains: rows,
				collapsed: {},
				groups: {},
				modelsOpen: true,
			}),
		).toBe(false);
		expect(
			allCollapsed({
				chains: rows,
				collapsed: {},
				groups: {},
				modelsOpen: false,
			}),
		).toBe(true);
		expect(
			allCollapsed({
				chains: rows,
				collapsed: { a: false },
				groups: {},
				modelsOpen: false,
			}),
		).toBe(false);
	});
	test("rowNote uses the shared note", () => {
		const note = rowNote(
			{
				...account("p1", "a"),
				limited: true,
				limitedReason: "quota",
				limitedUntil: 0,
			},
			"resets",
		);
		expect(note).toBe("quota");
	});
});
