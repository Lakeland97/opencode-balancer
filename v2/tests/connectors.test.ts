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

	test("two spellings of one version share a row", async () => {
		const db = freshDb();
		const catalog = await loadCatalog(
			ctxWith([
				model("p1", "claude-fable-5-2", "Claude Fable 5.2"),
				// cline-pass and open-design spell it with a dot; the picker showed
				// both as `Claude Fable 5.2`, and the model could not fail over
				// between the two halves of itself.
				model("p2", "anthropic/claude-fable-5.2", "Claude Fable 5.2"),
			]),
			db,
		);

		const rows = catalog.families.filter((family) =>
			family.name.startsWith("Claude Fable 5.2"),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.targets.map((route) => route.providerID).sort()).toEqual([
			"p1",
			"p2",
		]);
	});

	test("a label shared across id spellings is one row", async () => {
		const db = freshDb();
		const catalog = await loadCatalog(
			ctxWith([
				// The same model, one provider pinning the version the other
				// leaves off. Both call it `Muse Wonder`, so two rows gave the
				// picker two identical entries and neither could fail over.
				model("p1", "meta/muse-wonder-1.0", "Muse Wonder"),
				model("p2", "muse-wonder", "Muse Wonder"),
			]),
			db,
		);

		const rows = catalog.families.filter((family) =>
			family.name.startsWith("Muse Wonder"),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.targets.map((route) => route.providerID).sort()).toEqual([
			"p1",
			"p2",
		]);
	});

	test("a price marker is never merged away by a matching label", async () => {
		const db = freshDb();
		const catalog = await loadCatalog(
			ctxWith([
				// `hy3-paid` and `hy3` may well be the same weights, but one says
				// it bills and the other does not. Merging them would let a free
				// row spend, so they stay apart and are told apart by their labels
				// instead of both reading `Hy3`.
				model("p1", "hy3", "Hy3"),
				model("p2", "tencent/hy3-paid", "Hy3"),
			]),
			db,
		);

		const rows = catalog.families.filter((family) =>
			family.name.startsWith("Hy3"),
		);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.name)).size).toBe(2);
		expect(rows.map((row) => row.name).sort()).toEqual(["Hy3", "Hy3 (paid)"]);
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

	test("a row declares one thinking ladder merged from every target", async () => {
		const db = freshDb();
		const withVariants = (
			providerID: string,
			variants: { id: string; settings: Record<string, string> }[],
		) => ({
			...model(providerID, "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
				context: 200_000,
			}),
			variants,
		});

		let added: { id?: string; variants?: { id: string }[] }[] = [];
		const ctx = {
			model: {
				list: async () => ({
					data: [
						// The two shapes the real connectors return: three rungs
						// with a middle, four with a `none` and a `max`.
						withVariants("p1", [
							{ id: "low", settings: { reasoningEffort: "low" } },
							{ id: "medium", settings: { reasoningEffort: "medium" } },
							{ id: "high", settings: { reasoningEffort: "high" } },
						]),
						withVariants("p2", [
							{ id: "none", settings: { reasoningEffort: "none" } },
							{ id: "low", settings: { reasoningEffort: "low" } },
							{ id: "high", settings: { reasoningEffort: "high" } },
							{ id: "max", settings: { reasoningEffort: "max" } },
						]),
					],
				}),
			},
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

		await registerBalancerProvider({ ctx, db });

		const row = added.find((entry) => entry.id === "deepseek-v4.1-flash");
		// A picker offering only one target's names would hide levels the other
		// target has and offer ones it does not; the row offers the union, and
		// routing translates per target.
		expect(row?.variants?.map((variant) => variant.id)).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"max",
		]);
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

	test("a declared row always names its type and family", async () => {
		const db = freshDb();
		// A connector that leaves `type` and `family` off its record: the host
		// keeps such a model out of the picker, which is how the open-design
		// rows vanished while the provider was serving.
		const bare = twoConnectors.map((entry) => {
			const { type: _type, ...rest } = entry as Record<string, unknown>;
			return { ...rest, family: undefined };
		});
		const host = hostingCtx(bare);
		await registerBalancerProvider({ ctx: host.ctx, db });

		const row = host.declared("deepseek-v4.1-flash");
		expect(row?.type).toBe("chat");
		expect(row?.family).toBe("deepseek-v4.1-flash");
	});
});

type DeclaredModel = {
	family?: string;
	id: string;
	limit?: { context: number; output?: number };
	type?: string;
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
		declared: (id: string) => models.find((entry) => entry.id === id),
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
