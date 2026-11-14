import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { saveAccount } from "../core/accounts";
import { saveChain } from "../core/chains";
import { setProviderEnabled } from "../core/priority";
import { migrate } from "../core/schema";
import {
	invalidateCatalog,
	loadCatalog,
	type ModelFamily,
} from "../server/connectors";
import { markRateLimited } from "../server/request-state";
import {
	chooseRoute,
	chooseRouteForRequest,
	estimateTokens,
	isProviderEnabled,
} from "../server/routing";

const PACKAGE = "@opencode/ai/providers/openai-compatible";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	saveAccount(db, "p1", "a", { key: "k1", type: "api" });
	saveAccount(db, "p2", "a", { key: "k2", type: "api" });
	return db;
}

function model(providerID: string, modelID: string, context: number) {
	return {
		enabled: true,
		limit: { context, output: 4096 },
		modelID,
		name: modelID,
		package: PACKAGE,
		providerID,
		settings: { baseURL: `https://${providerID}.invalid/v1` },
		type: "chat",
	};
}

const ordinary = [
	model("p1", "deepseek-v4.1-flash", 1_000_000),
	model("p2", "deepseek-v4.1-flash", 200_000),
];

async function familyFor(db: Database, data: unknown[]) {
	invalidateCatalog();
	const catalog = await loadCatalog(
		{ model: { list: async () => ({ data }) } } as never,
		db,
	);
	const family = catalog.families.find(
		(entry) => entry.key === "deepseek-v4.1-flash",
	);
	if (!family) throw new Error("family missing");
	return family;
}

function store(
	db: Database,
	targets: { providerID: string; modelID: string }[],
) {
	saveChain(db, {
		familyKey: "deepseek-v4.1-flash",
		label: "DeepSeek V4.1 Flash",
		package: PACKAGE,
		targets: targets.map((target) => ({
			baseURL: `https://${target.providerID}.invalid/v1`,
			modelID: target.modelID,
			providerID: target.providerID,
		})),
	});
}

describe("chain routing", () => {
	test("the second target serves when the first provider is limited", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		markRateLimited(db, "p1", "a");

		expect(chooseRoute(db, family)?.providerID).toBe("p2");
	});

	test("a disabled provider is skipped in a stored chain", async () => {
		const db = freshDb();
		store(db, [
			{ modelID: "deepseek-v4.1-flash", providerID: "p1" },
			{ modelID: "deepseek-v4.1-flash", providerID: "p2" },
		]);
		const family = await familyFor(db, ordinary);
		setProviderEnabled(db, "p1", false);

		expect(chooseRoute(db, family)?.providerID).toBe("p2");
	});

	test("a disabled provider is skipped in an automatic chain", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		setProviderEnabled(db, "p1", false);

		expect(chooseRoute(db, family)?.providerID).toBe("p2");
	});

	test("a disabled provider comes back when re-enabled", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		setProviderEnabled(db, "p1", false);
		setProviderEnabled(db, "p1", true);

		expect(chooseRoute(db, family)?.providerID).toBe("p1");
	});

	test("an unavailable target does not break the row", async () => {
		const db = freshDb();
		store(db, [
			{ modelID: "withdrawn", providerID: "p1" },
			{ modelID: "deepseek-v4.1-flash", providerID: "p2" },
		]);
		const family = await familyFor(db, ordinary);

		expect(chooseRoute(db, family)?.providerID).toBe("p2");
	});

	test("excluded providers are not retried", async () => {
		const db = freshDb();
		store(db, [
			{ modelID: "deepseek-v4.1-flash", providerID: "p1" },
			{ modelID: "deepseek-v4.1-flash", providerID: "p2" },
		]);
		const family = await familyFor(db, ordinary);

		expect(chooseRoute(db, family, new Set(["p1"]))?.providerID).toBe("p2");
	});
});

describe("overflow guard", () => {
	test("with auto compaction off, a target smaller than the conversation is skipped", async () => {
		const db = freshDb();
		const family: ModelFamily = await familyFor(db, [
			model("p1", "deepseek-v4.1-flash", 200_000),
			model("p2", "deepseek-v4.1-flash", 1_000_000),
		]);
		const body = "x".repeat(900_000);

		expect(estimateTokens(body)).toBe(225_000);
		expect(
			chooseRouteForRequest(db, family, body, { guardOverflow: true })
				?.providerID,
		).toBe("p2");
	});

	test("the same request ignores the guard when auto compaction is on", async () => {
		const db = freshDb();
		const family = await familyFor(db, [
			model("p1", "deepseek-v4.1-flash", 200_000),
			model("p2", "deepseek-v4.1-flash", 1_000_000),
		]);
		const body = "x".repeat(900_000);

		expect(
			chooseRouteForRequest(db, family, body, { guardOverflow: false })
				?.providerID,
		).toBe("p1");
	});
});

describe("provider state", () => {
	test("a provider with no stored row is enabled", () => {
		const db = freshDb();
		expect(isProviderEnabled(db, "p1")).toBe(true);
	});
});
