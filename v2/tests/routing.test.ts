import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	accountKey,
	saveAccount,
	setAccountEnabled,
	setAccountFreeOnly,
} from "../core/accounts";
import { saveChain } from "../core/chains";
import { isFreeModel } from "../core/models";
import { migrate } from "../core/schema";
import { invalidateCatalog, loadCatalog } from "../server/connectors";
import { markRateLimited } from "../server/request-state";
import { noteServed } from "../server/route-memory";
import {
	chooseFailoverRoute,
	chooseLastServed,
	chooseRoute,
	chooseRouteAtAnyCost,
	hasAlternativeRoute,
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

function paid(providerID: string, modelID: string) {
	const record = model(providerID, modelID, 1_000_000);
	return { ...record, cost: [{ input: 0.5, output: 1 }] };
}

function free(providerID: string, modelID: string) {
	const record = model(providerID, modelID, 200_000);
	return { ...record, cost: [{ input: 0, output: 0 }] };
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

	test("a disabled credential is skipped in a stored chain", async () => {
		const db = freshDb();
		store(db, [
			{ modelID: "deepseek-v4.1-flash", providerID: "p1" },
			{ modelID: "deepseek-v4.1-flash", providerID: "p2" },
		]);
		const family = await familyFor(db, ordinary);
		setAccountEnabled(db, "p1", "a", false);

		expect(chooseRoute(db, family)?.providerID).toBe("p2");
	});

	test("a disabled credential is skipped in an automatic chain", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		setAccountEnabled(db, "p1", "a", false);

		expect(chooseRoute(db, family)?.providerID).toBe("p2");
	});

	test("a disabled credential comes back when re-enabled", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		setAccountEnabled(db, "p1", "a", false);
		setAccountEnabled(db, "p1", "a", true);

		expect(chooseRoute(db, family)?.providerID).toBe("p1");
	});

	test("the other credential of a provider answers when one is limited", async () => {
		// A provider's second credential is a second chance, not a provider the
		// router writes off along with the first.
		const db = freshDb();
		store(db, [
			{ modelID: "deepseek-v4.1-flash", providerID: "p1" },
			{ modelID: "deepseek-v4.1-flash", providerID: "p2" },
		]);
		saveAccount(db, "p1", "b", { key: "k3", type: "api" });
		const family = await familyFor(db, ordinary);
		markRateLimited(db, "p1", "a");

		const route = chooseRoute(db, family);
		expect(route?.providerID).toBe("p1");
		expect(route?.account.alias).toBe("b");
		// Which is exactly what the session is asked before handing it the
		// failure: parking p1/a leaves p1/b to try.
		expect(hasAlternativeRoute(db, family, accountKey("p1", "a"))).toBe(true);
	});

	test("the order the panel shows is the order routing walks", async () => {
		const db = freshDb();
		// The order is p1/a, p2/a, p1/b: p1's second credential sits below p2/a,
		// because that is where the panel puts it and the list is the order.
		saveAccount(db, "p1", "b", { key: "k3", type: "api" });
		const family = await familyFor(db, ordinary);

		markRateLimited(db, "p1", "a");
		expect(chooseRoute(db, family)?.providerID).toBe("p2");
		markRateLimited(db, "p2", "a");
		const next = chooseRoute(db, family);
		expect(next?.providerID).toBe("p1");
		expect(next?.account.alias).toBe("b");
	});

	test("a stored chain keeps the provider order it was written with", async () => {
		const db = freshDb();
		// Same credentials, but the row was handed an explicit order, so p1's
		// other credential is tried before p2 is, as the chain says.
		store(db, [
			{ modelID: "deepseek-v4.1-flash", providerID: "p1" },
			{ modelID: "deepseek-v4.1-flash", providerID: "p2" },
		]);
		saveAccount(db, "p1", "b", { key: "k3", type: "api" });
		const family = await familyFor(db, ordinary);
		markRateLimited(db, "p1", "a");

		expect(chooseRoute(db, family)?.account.alias).toBe("b");
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

	test("excluded credentials are not retried", async () => {
		const db = freshDb();
		store(db, [
			{ modelID: "deepseek-v4.1-flash", providerID: "p1" },
			{ modelID: "deepseek-v4.1-flash", providerID: "p2" },
		]);
		const family = await familyFor(db, ordinary);

		expect(
			chooseRoute(db, family, new Set([accountKey("p1", "a")]))?.providerID,
		).toBe("p2");
	});

	test("a conversation is never held back for being large", async () => {
		const db = freshDb();
		const family = await familyFor(db, [
			model("p1", "deepseek-v4.1-flash", 200_000),
			model("p2", "deepseek-v4.1-flash", 1_000_000),
		]);

		// Which connector is too small for the conversation is no longer a
		// routing question: the balancer compacts the conversation itself, so
		// the row keeps to the first healthy target and reports its window for
		// the compaction threshold to be clamped by.
		expect(chooseRoute(db, family)?.providerID).toBe("p1");
		expect(chooseRoute(db, family)?.context).toBe(200_000);
	});

	test("a conversation that fills a target's window is not handed to it", async () => {
		const db = freshDb();
		const family = await familyFor(db, [
			model("p1", "deepseek-v4.1-flash", 200_000),
			model("p2", "deepseek-v4.1-flash", 1_000_000),
		]);

		// 250k already fills p1's window. The provider would reject the request
		// outright, so it must not be a failover target for this prompt.
		expect(chooseRoute(db, family, new Set(), 250_000)?.providerID).toBe("p2");

		// A prompt that fits still prefers the first target.
		expect(chooseRoute(db, family, new Set(), 150_000)?.providerID).toBe("p1");
	});
});

describe("free-only credentials", () => {
	test("free variants are recognised by id or zero cost", () => {
		// No pricing data means unknown, which must not be read as free.
		expect(isFreeModel({ cost: [], modelID: "openai/gpt-5" })).toBe(false);
		expect(isFreeModel({ modelID: "openai/gpt-5" })).toBe(false);
		expect(
			isFreeModel({
				cost: [{ input: 0, output: 0 }],
				modelID: "deepseek-v4.1",
			}),
		).toBe(true);
		expect(
			isFreeModel({
				cost: [{ input: 0.5, output: 1 }],
				modelID: "deepseek-v4.1-flash",
			}),
		).toBe(false);
		expect(
			isFreeModel({
				cost: [{ input: 0.5, output: 1 }],
				modelID: "opencode/deepseek-v4.1-flash-free",
			}),
		).toBe(true);
		expect(
			isFreeModel({ cost: [{ input: 0.5, output: 1 }], modelID: "ling:free" }),
		).toBe(true);
	});

	test("a free-only credential is skipped for a paid target", async () => {
		const db = freshDb();
		const family = await familyFor(db, [
			paid("p1", "deepseek-v4.1-flash"),
			paid("p2", "deepseek-v4.1-flash"),
		]);
		setAccountFreeOnly(db, "p1", "a", true);

		expect(chooseRoute(db, family)?.providerID).toBe("p2");
	});

	test("a free-only credential serves its own free spelling instead", async () => {
		const db = freshDb();
		const family = await familyFor(db, [
			paid("p1", "deepseek-v4.1-flash"),
			free("p1", "deepseek-v4.1-flash-free"),
			paid("p2", "deepseek-v4.1-flash"),
		]);
		setAccountFreeOnly(db, "p1", "a", true);

		expect(chooseRoute(db, family)?.modelID).toBe("deepseek-v4.1-flash-free");
		expect(chooseRoute(db, family)?.providerID).toBe("p1");
	});

	test("free-only belongs to the credential, not the provider", async () => {
		const db = freshDb();
		const family = await familyFor(db, [
			paid("p1", "deepseek-v4.1-flash"),
			free("p1", "deepseek-v4.1-flash-free"),
			paid("p2", "deepseek-v4.1-flash"),
		]);
		saveAccount(db, "p1", "b", { key: "k3", type: "api" });
		// Only the first credential is told to spend nothing.
		setAccountFreeOnly(db, "p1", "a", true);

		expect(chooseRoute(db, family)?.account.alias).toBe("a");
		expect(chooseRoute(db, family)?.modelID).toBe("deepseek-v4.1-flash-free");

		// With that credential parked, the next row in the order serves: the
		// panel's list is the routing order, and p2/a sits above p1/b.
		markRateLimited(db, "p1", "a");
		expect(chooseRoute(db, family)?.providerID).toBe("p2");

		// Its neighbour is still a chance rather than written off with the
		// provider, and it serves the paid spelling because only p1/a was told
		// to spend nothing.
		markRateLimited(db, "p2", "a");
		const next = chooseRoute(db, family);
		expect(next?.providerID).toBe("p1");
		expect(next?.account.alias).toBe("b");
		expect(next?.modelID).toBe("deepseek-v4.1-flash");
	});
});

describe("the target that last answered", () => {
	test("it answers a row nothing else can route", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		noteServed(db, family.key, {
			alias: "a",
			modelID: "deepseek-v4.1-flash",
			providerID: "p2",
		});

		// Everything about the row is a prediction; this is the one fact in it.
		const route = chooseLastServed(db, family);
		expect(route?.providerID).toBe("p2");
		expect(route?.account.alias).toBe("a");
	});

	test("a row that has never answered has nothing to fall back to", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);

		expect(chooseLastServed(db, family)).toBeUndefined();
	});

	test("the credential that answered is preferred over another on the same provider", async () => {
		const db = freshDb();
		saveAccount(db, "p2", "b", { key: "k3", type: "api" });
		const family = await familyFor(db, ordinary);
		noteServed(db, family.key, {
			alias: "b",
			modelID: "deepseek-v4.1-flash",
			providerID: "p2",
		});

		expect(chooseLastServed(db, family)?.account.alias).toBe("b");
	});

	test("a spent credential falls through to the provider's other key", async () => {
		const db = freshDb();
		saveAccount(db, "p2", "b", { key: "k3", type: "api" });
		const family = await familyFor(db, ordinary);
		noteServed(db, family.key, {
			alias: "b",
			modelID: "deepseek-v4.1-flash",
			providerID: "p2",
		});

		// The walk already tried `b`; the same model on the same provider with a
		// different key is still an attempt worth making.
		expect(chooseLastServed(db, family, new Set(["p2/b"]))?.account.alias).toBe(
			"a",
		);
	});

	test("a target already tried in this walk is not offered again", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		noteServed(db, family.key, {
			alias: "a",
			modelID: "deepseek-v4.1-flash",
			providerID: "p2",
		});

		expect(chooseLastServed(db, family, new Set(["p2/a"]))).toBeUndefined();
	});

	test("a disabled provider is not a fallback", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		noteServed(db, family.key, {
			alias: "a",
			modelID: "deepseek-v4.1-flash",
			providerID: "p2",
		});
		setAccountEnabled(db, "p2", "a", false);

		expect(chooseLastServed(db, family)).toBeUndefined();
	});

	test("a row with nothing enabled and nothing served sends nowhere", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		setAccountEnabled(db, "p1", "a", false);
		setAccountEnabled(db, "p2", "a", false);

		// The last resort still needs a key: sending a request with no credential
		// would fail as an authentication error nobody can act on.
		expect(chooseRouteAtAnyCost(db, family)).toBeUndefined();
	});
});

describe("a conversation larger than a healthy target", () => {
	test("the healthy small window is cut to fit before a parked large one", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		// p1 holds 1M and p2 holds 200k. The conversation is past 200k, so the
		// only healthy target cannot take it as written — but cutting the oldest
		// turns fits it, and that beats handing it to a parked 1M target.
		markRateLimited(db, "p1", "a");

		const route = chooseFailoverRoute(db, family, undefined, 250_000);

		expect(route?.providerID).toBe("p2");
	});

	test("a target that can hold the conversation is preferred without a cut", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);

		const route = chooseFailoverRoute(db, family, undefined, 250_000);

		expect(route?.providerID).toBe("p1");
	});

	test("the widest healthy window is chosen, because it loses the least", async () => {
		const db = freshDb();
		saveAccount(db, "p3", "a", { key: "k3", type: "api" });
		const family = await familyFor(db, [
			model("p1", "deepseek-v4.1-flash", 400_000),
			model("p2", "deepseek-v4.1-flash", 300_000),
			model("p3", "deepseek-v4.1-flash", 200_000),
		]);
		markRateLimited(db, "p1", "a");

		const route = chooseFailoverRoute(db, family, undefined, 500_000);

		expect(route?.providerID).toBe("p2");
	});

	test("with no healthy window left the largest target still answers", async () => {
		const db = freshDb();
		const family = await familyFor(db, ordinary);
		markRateLimited(db, "p1", "a");
		markRateLimited(db, "p2", "a");

		const route = chooseFailoverRoute(db, family, undefined, 250_000);

		expect(route?.providerID).toBe("p1");
	});
});
