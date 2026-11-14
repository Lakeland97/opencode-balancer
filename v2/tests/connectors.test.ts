import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { saveAccount } from "../core/accounts";
import { saveChain } from "../core/chains";
import { migrate } from "../core/schema";
import {
	invalidateCatalog,
	loadCatalog,
	refreshBalancerProvider,
	registerBalancerProvider,
	resolveChain,
} from "../server/connectors";

const PACKAGE = "@opencode/ai/providers/openai-compatible";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	saveAccount(db, "p1", "a", { key: "k1", type: "api" });
	saveAccount(db, "p2", "a", { key: "k2", type: "api" });
	return db;
}

function model(
	providerID: string,
	modelID: string,
	name: string,
	limit?: { context: number; output?: number },
) {
	return {
		enabled: true,
		limit: limit
			? { context: limit.context, output: limit.output ?? 4096 }
			: undefined,
		modelID,
		name,
		package: PACKAGE,
		providerID,
		settings: { baseURL: `https://${providerID}.invalid/v1` },
		type: "chat",
	};
}

function ctxWith(data: unknown[]) {
	return { model: { list: async () => ({ data }) } } as never;
}

const twoConnectors = [
	model("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
		context: 1_000_000,
		output: 384_000,
	}),
	model("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
		context: 200_000,
		output: 32_000,
	}),
];

beforeEach(() => {
	invalidateCatalog();
});

describe("catalog rows", () => {
	test("a stored chain replaces the automatic route order", async () => {
		const db = freshDb();
		saveChain(db, {
			familyKey: "deepseek-v4.1-flash",
			label: "DeepSeek V4.1 Flash",
			package: PACKAGE,
			targets: [
				{
					baseURL: "https://p2.invalid/v1",
					modelID: "deepseek-v4.1-flash",
					providerID: "p2",
				},
				{
					baseURL: "https://p1.invalid/v1",
					modelID: "deepseek-v4.1-flash",
					providerID: "p1",
				},
			],
		});

		const catalog = await loadCatalog(ctxWith(twoConnectors), db);
		const family = catalog.families.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(family?.stored).toBe(true);
		expect(resolveChain(db, family!).map((route) => route.providerID)).toEqual([
			"p2",
			"p1",
		]);
	});

	test("a stored chain with no catalog family still yields a row", async () => {
		const db = freshDb();
		saveChain(db, {
			familyKey: "withdrawn-model",
			label: "Withdrawn Model",
			package: PACKAGE,
			targets: [
				{ baseURL: "https://p1.invalid/v1", modelID: "gone", providerID: "p1" },
			],
		});

		const catalog = await loadCatalog(ctxWith(twoConnectors), db);
		const family = catalog.families.find(
			(entry) => entry.key === "withdrawn-model",
		);
		expect(family?.name).toBe("Withdrawn Model");
		expect(resolveChain(db, family!).map((route) => route.modelID)).toEqual([
			"gone",
		]);
	});

	test("a stored chain with zero targets is ignored", async () => {
		const db = freshDb();
		db.query(
			`INSERT INTO model_chains (family_key, label, package, updated_at)
             VALUES (?, ?, ?, ?)`,
		).run("empty-row", "Empty", PACKAGE, Date.now());

		const catalog = await loadCatalog(ctxWith(twoConnectors), db);
		expect(catalog.families.some((family) => family.key === "empty-row")).toBe(
			false,
		);
	});

	test("a route carries the free spelling a credential may be pointed at", async () => {
		const db = freshDb();
		const catalog = await loadCatalog(
			ctxWith([
				model("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
					context: 1_000_000,
					output: 384_000,
				}),
				model("p1", "deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash", {
					context: 200_000,
					output: 32_000,
				}),
				model("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
					context: 1_000_000,
					output: 384_000,
				}),
			]),
			db,
		);
		const family = catalog.families.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		const p1 = family?.targets.find((route) => route.providerID === "p1");

		// Whether the free spelling is sent is a per-credential decision, so the
		// route is the model it names and carries the free one beside it. A
		// credential told to spend nothing gets the variant, whose window is what
		// the compaction share is then clamped by.
		expect(p1?.modelID).toBe("deepseek-v4.1-flash");
		expect(p1?.context).toBe(1_000_000);
		expect(p1?.freeVariant?.modelID).toBe("deepseek-v4.1-flash-free");
		expect(p1?.freeVariant?.context).toBe(200_000);
		expect(p1?.freeVariant?.output).toBe(32_000);
	});

	test("a stored chain target carries its free spelling too", async () => {
		const db = freshDb();
		saveChain(db, {
			familyKey: "deepseek-v4.1-flash",
			label: "DeepSeek V4.1 Flash",
			package: PACKAGE,
			targets: [
				{
					baseURL: "https://p1.invalid/v1",
					modelID: "deepseek-v4.1-flash",
					providerID: "p1",
				},
			],
		});
		const catalog = await loadCatalog(
			ctxWith([
				model("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
					context: 1_000_000,
					output: 384_000,
				}),
				model("p1", "deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash", {
					context: 200_000,
					output: 32_000,
				}),
			]),
			db,
		);
		const family = catalog.families.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);

		expect(family?.targets[0]?.context).toBe(1_000_000);
		expect(family?.targets[0]?.freeVariant?.modelID).toBe(
			"deepseek-v4.1-flash-free",
		);
		expect(family?.targets[0]?.freeVariant?.context).toBe(200_000);
	});

	test("a stored target keeps its own baseURL", async () => {
		const db = freshDb();
		saveChain(db, {
			familyKey: "deepseek-v4.1-flash",
			label: "DeepSeek V4.1 Flash",
			package: PACKAGE,
			targets: [
				{
					baseURL: "https://mirror.invalid/v1/",
					modelID: "deepseek-v4.1-flash",
					providerID: "p1",
				},
			],
		});

		const catalog = await loadCatalog(ctxWith(twoConnectors), db);
		const family = catalog.families.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(resolveChain(db, family!)[0]?.baseURL).toBe(
			"https://mirror.invalid/v1",
		);
	});
});

describe("provider registration", () => {
	test("a row with no source model still has the fields the host sorts on", async () => {
		const db = freshDb();
		saveChain(db, {
			familyKey: "withdrawn-model",
			label: "Withdrawn Model",
			package: PACKAGE,
			targets: [
				{ baseURL: "https://p1.invalid/v1", modelID: "gone", providerID: "p1" },
			],
		});

		let added: {
			id?: string;
			time?: { released: number };
			cost?: unknown[];
		}[] = [];
		const ctx = {
			model: { list: async () => ({ data: twoConnectors }) },
			provider: {
				transform: async (
					fn: (editor: { add: (value: { models: unknown[] }) => void }) => void,
				) => {
					fn({
						add: (value) => {
							added = value.models as typeof added;
						},
					});
				},
			},
		} as never;

		await registerBalancerProvider({
			ctx,
			db,
		});

		const row = added.find((entry) => entry.id === "withdrawn-model");
		expect(row).toBeDefined();
		expect(typeof row?.time?.released).toBe("number");
		expect(Array.isArray(row?.cost)).toBe(true);
	});

	test("every declared model claims the same 1M window", async () => {
		const db = freshDb();
		saveChain(db, {
			familyKey: "deepseek-v4.1-flash",
			label: "DeepSeek V4.1 Flash",
			package: PACKAGE,
			targets: [
				{
					baseURL: "https://p1.invalid/v1",
					modelID: "deepseek-v4.1-flash",
					providerID: "p1",
				},
				{
					baseURL: "https://p2.invalid/v1",
					modelID: "deepseek-v4.1-flash",
					providerID: "p2",
				},
			],
		});

		const host = hostingCtx(twoConnectors);
		await registerBalancerProvider({ ctx: host.ctx, db });

		// The window is not the row's own: the host must be unable to decide
		// when the conversation is trimmed. The output is the smallest any hop
		// can answer, so every target can serve it.
		expect(host.declaredOf("deepseek-v4.1-flash")).toEqual({
			context: 1_000_000,
			output: 32_000,
		});
	});
});

type DeclaredModel = {
	id: string;
	limit?: { context: number; output?: number };
};

/** A host that keeps the provider transform and replays it on reload. */
function hostingCtx(data: unknown[]) {
	let transform: ((editor: Editor) => void) | undefined;
	let models: DeclaredModel[] = [];
	const editor: Editor = {
		add: (input) => {
			models = input.models;
		},
	};
	const ctx = {
		model: { list: async () => ({ data }) },
		provider: {
			reload: async () => {
				models = [];
				transform?.(editor);
			},
			transform: async (callback: (editor: Editor) => void) => {
				transform = callback;
				callback(editor);
				return { dispose: async () => {} };
			},
		},
	} as never;
	return {
		ctx,
		declaredOf: (id: string) => models.find((entry) => entry.id === id)?.limit,
	};
}

type Editor = { add: (input: { models: DeclaredModel[] }) => void };

describe("provider re-declaration", () => {
	test("a refreshed provider follows the chain it now has", async () => {
		const db = freshDb();
		const host = hostingCtx(twoConnectors);
		await registerBalancerProvider({
			ctx: host.ctx,
			db,
		});

		// Two targets, so the row can only promise the smaller output; the
		// window is the declared 1M either way.
		expect(host.declaredOf("deepseek-v4.1-flash")).toEqual({
			context: 1_000_000,
			output: 32_000,
		});

		// Narrow the row to the 1M connector alone.
		saveChain(db, {
			familyKey: "deepseek-v4.1-flash",
			label: "DeepSeek V4.1 Flash",
			package: PACKAGE,
			targets: [
				{
					baseURL: "https://p1.invalid/v1",
					modelID: "deepseek-v4.1-flash",
					providerID: "p1",
				},
			],
		});
		await refreshBalancerProvider({
			ctx: host.ctx,
			db,
		});

		// One target left, so the row can promise its larger output.
		expect(host.declaredOf("deepseek-v4.1-flash")).toEqual({
			context: 1_000_000,
			output: 384_000,
		});
	});
});
