import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	deleteChain,
	getStoredChain,
	listStoredChains,
	moveTarget,
	saveChain,
} from "../core/chains";
import { migrate } from "../core/schema";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

function target(providerID: string, modelID = `${providerID}-model`) {
	return {
		baseURL: `https://${providerID}.invalid/v1`,
		modelID,
		providerID,
	};
}

const chain = (familyKey: string, targets: ReturnType<typeof target>[]) => ({
	familyKey,
	label: "DeepSeek V4.1 Flash",
	package: "@opencode/ai/providers/openai-compatible",
	targets,
});

describe("chain store", () => {
	test("saving a chain replaces its targets atomically", () => {
		const db = freshDb();
		saveChain(db, chain("deepseek-v4.1-flash", [target("a"), target("b")]));
		saveChain(db, chain("deepseek-v4.1-flash", [target("c")]));

		expect(
			getStoredChain(db, "deepseek-v4.1-flash")?.targets.map(
				(entry) => entry.providerID,
			),
		).toEqual(["c"]);
		expect(listStoredChains(db)).toHaveLength(1);
	});

	test("targets come back in stored order", () => {
		const db = freshDb();
		saveChain(db, chain("row", [target("b"), target("a")]));

		expect(
			getStoredChain(db, "row")?.targets.map((entry) => entry.providerID),
		).toEqual(["b", "a"]);
	});

	test("moveTarget swaps neighbours and ignores the edges", () => {
		const db = freshDb();
		saveChain(db, chain("row", [target("a"), target("b")]));

		expect(moveTarget(db, "row", "b", -1)).toBe(true);
		expect(
			getStoredChain(db, "row")?.targets.map((entry) => entry.providerID),
		).toEqual(["b", "a"]);

		expect(moveTarget(db, "row", "a", 1)).toBe(false);
		expect(moveTarget(db, "row", "missing", -1)).toBe(false);
	});

	test("deleteChain removes the row and reports whether it existed", () => {
		const db = freshDb();
		saveChain(db, chain("row", [target("a")]));

		expect(deleteChain(db, "row")).toBe(true);
		expect(deleteChain(db, "row")).toBe(false);
		expect(getStoredChain(db, "row")).toBeUndefined();
	});

	test("a chain with no targets is not stored", () => {
		const db = freshDb();
		saveChain(db, chain("row", [target("a")]));
		saveChain(db, chain("row", []));

		expect(getStoredChain(db, "row")).toBeUndefined();
		expect(listStoredChains(db)).toEqual([]);
	});
});
