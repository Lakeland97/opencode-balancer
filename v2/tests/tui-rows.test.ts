import { describe, expect, test } from "bun:test";
import {
	allCollapsed,
	providerEntries,
	rowNote,
	servingLine,
	visibleChains,
} from "../tui/rows";
import type { Account, Chain, InUseEntry, Provider } from "../types";

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

function serving(overrides: Partial<InUseEntry> = {}): InUseEntry {
	return {
		agent: "build",
		alias: "account-1",
		applied: "high",
		// Unset by default so the text assertions below read as the line alone;
		// the tests that care about the moment set it.
		at: 0,
		familyKey: "deepseek",
		label: "DeepSeek Pro",
		modelID: "deepseek-v4.1-flash",
		providerID: "open-design",
		variant: "high",
		...overrides,
	};
}

function chain(key: string, stored: boolean, targets: number): Chain {
	return {
		context: 0,
		key,
		label: key,
		limit: "",
		package: PACKAGE,
		stored,
		targets: Array.from({ length: targets }, (_, index) => ({
			context: 0,
			modelID: key,
			name: key,
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

describe("serving lines", () => {
	const now = new Date(2026, 10, 15, 12, 0).getTime();
	test("names the connector's model, not the row label", () => {
		const line = servingLine(serving(), now);
		expect(line.text).toBe("build · open-design/deepseek-v4.1-flash (high)");
		expect(line.text).not.toContain("DeepSeek Pro");
	});
	test("adds when the row last served", () => {
		expect(servingLine(serving({ at: now - 120_000 }), now).text).toBe(
			"build · open-design/deepseek-v4.1-flash (high) · 2m ago",
		);
	});
	test("shows the level actually applied", () => {
		expect(servingLine(serving({ applied: "medium" }), now).text).toContain(
			"(medium)",
		);
	});
	test("falls back to ? for a missing agent and drops an absent level", () => {
		expect(servingLine(serving({ agent: "", applied: "" }), now).text).toBe(
			"? · open-design/deepseek-v4.1-flash",
		);
	});
	test("keeps a level the request asked for but did not get", () => {
		const line = servingLine(serving({ applied: "low", variant: "high" }), now);
		expect(line.text).toBe("build · open-design/deepseek-v4.1-flash (low)");
		expect(line.note).toContain("high");
		expect(line.note).toContain("low");
	});
	test("says nothing extra when the asked level is the applied one", () => {
		expect(servingLine(serving(), now).note).toBe("");
	});
});
