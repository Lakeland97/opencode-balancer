import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { saveAccount, setAccountEnabled } from "../core/accounts";
import { saveChain } from "../core/chains";
import { setAssumeWindows } from "../core/priority";
import { migrate } from "../core/schema";
import {
	invalidateCatalog,
	loadCatalog,
	refreshBalancerProvider,
	registerBalancerProvider,
	resolveChain,
} from "../server/connectors";
import {
	cachedRemoteModels,
	invalidateRemoteModels,
	refreshRemoteModels,
} from "../server/remote-models";

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
		// A picker may carry a level over from the model the session used before,
		// and the host refuses one the row does not declare, so the row declares
		// the whole ladder; routing translates per target.
		expect(row?.variants?.map((variant) => variant.id)).toEqual([
			"none",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
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
	test("a window the provider never published is not the host's placeholder", async () => {
		const db = freshDb();
		// The host fills a default window into every connector it loads, so a
		// model the provider lists without one arrives here looking like a 200k
		// model. It is not: the number is the host's own fallback, and trusting
		// it makes the balancer cut a conversation that the provider can hold —
		// SayGM answered 253k for a 200k-declared model.
		const host = [
			model("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
				context: 200_000,
				output: 32_000,
			}),
		];
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [{ id: "deepseek-v4.1-flash" }] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})) as unknown as typeof fetch;
		try {
			invalidateRemoteModels();
			// The catalogue read is never awaited by routing, so the first pass
			// starts it and the second one sees the answer.
			cachedRemoteModels(db, "p2", "https://p2.invalid/v1");
			await new Promise((resolve) => setTimeout(resolve, 0));
			invalidateCatalog();
			const catalog = await loadCatalog(ctxWith(host), db);
			const family = catalog.families.find(
				(entry) => entry.key === "deepseek-v4.1-flash",
			);
			const route = family?.targets.find(
				(target) => target.providerID === "p2",
			);
			expect(route?.context).toBeUndefined();
		} finally {
			globalThis.fetch = original;
		}
	});

	test("a window the provider did publish still wins", async () => {
		const db = freshDb();
		const host = [
			model("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
				context: 200_000,
				output: 32_000,
			}),
		];
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					data: [{ context_length: 1048000, id: "deepseek-v4.1-flash" }],
				}),
				{ headers: { "content-type": "application/json" }, status: 200 },
			)) as unknown as typeof fetch;
		try {
			invalidateRemoteModels();
			cachedRemoteModels(db, "p2", "https://p2.invalid/v1");
			await new Promise((resolve) => setTimeout(resolve, 0));
			invalidateCatalog();
			const catalog = await loadCatalog(ctxWith(host), db);
			const family = catalog.families.find(
				(entry) => entry.key === "deepseek-v4.1-flash",
			);
			const route = family?.targets.find(
				(target) => target.providerID === "p2",
			);
			expect(route?.context).toBe(1_048_000);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("a provider with no catalogue at all keeps its declared window", async () => {
		const db = freshDb();
		const host = [
			model("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
				context: 200_000,
				output: 32_000,
			}),
		];
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("nope", { status: 404 })) as unknown as typeof fetch;
		try {
			invalidateRemoteModels();
			cachedRemoteModels(db, "p2", "https://p2.invalid/v1");
			await new Promise((resolve) => setTimeout(resolve, 0));
			invalidateCatalog();
			const catalog = await loadCatalog(ctxWith(host), db);
			const family = catalog.families.find(
				(entry) => entry.key === "deepseek-v4.1-flash",
			);
			const route = family?.targets.find(
				(target) => target.providerID === "p2",
			);
			expect(route?.context).toBe(200_000);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("a credential switched off for routing still reads the catalogue", async () => {
		// Switching a provider off is a routing decision, not a deleted key. It
		// must not also switch the provider back to the hardcoded list in
		// `opencode.json`: with every other provider disabled, that is the whole
		// difference between the provider's own catalogue and a stale snapshot.
		const db = freshDb();
		setAccountEnabled(db, "p2", "a", false);

		const original = globalThis.fetch;
		let sent: RequestInit | undefined;
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			sent = init;
			return new Response(JSON.stringify({ data: [{ id: "fresh" }] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		}) as unknown as typeof fetch;
		try {
			invalidateRemoteModels();
			cachedRemoteModels(db, "p2", "https://p2.invalid/v1");
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(sent).toBeDefined();
			const headers = sent?.headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer k2");
			expect(headers["user-agent"]).toContain("opencode-balancer");
		} finally {
			globalThis.fetch = original;
		}
	});

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

/**
 * A host that describes its providers separately from their models, which is
 * what makes a provider with no `opencode.json` models visible at all.
 */
function hostWith(
	providers: Array<{ baseURL: string; id: string; package?: string }>,
	data: unknown[],
) {
	return {
		model: { list: async () => ({ data }) },
		provider: {
			list: async () => ({
				data: providers.map((provider) => ({
					id: provider.id,
					package: provider.package ?? PACKAGE,
					settings: { baseURL: provider.baseURL },
				})),
			}),
		},
	} as never;
}

/** One answer per provider base URL, the way their `/models` would answer. */
function catalogues(map: Record<string, unknown[]>) {
	return (async (url: string) => {
		const base = Object.keys(map).find((entry) =>
			String(url).startsWith(entry),
		);
		if (!base) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify({ data: map[base] }), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	}) as unknown as typeof fetch;
}

async function warm(
	db: Database,
	map: Record<string, unknown[]>,
	providers: string[],
) {
	const original = globalThis.fetch;
	globalThis.fetch = catalogues(map);
	try {
		invalidateRemoteModels();
		await refreshRemoteModels(
			db,
			providers.map((providerID) => ({
				baseURL: `https://${providerID}.invalid/v1`,
				providerID,
			})),
		);
	} finally {
		globalThis.fetch = original;
	}
}

describe("a provider described only by its catalogue", () => {
	test("rows exist with no declared models at all", async () => {
		const db = freshDb();
		await warm(
			db,
			{
				"https://p1.invalid/v1": [{ context_length: 500_000, id: "alpha-1" }],
			},
			["p1"],
		);
		invalidateCatalog();
		const catalog = await loadCatalog(
			hostWith([{ baseURL: "https://p1.invalid/v1", id: "p1" }], []),
			db,
		);
		const family = catalog.families.find((entry) => entry.key === "alpha-1");
		expect(family?.targets.map((target) => target.providerID)).toEqual(["p1"]);
		expect(family?.targets[0].context).toBe(500_000);
		expect(family?.targets[0].contextSource).toBe("published");
	});

	test("a model that answers only on /messages picks the Anthropic package", async () => {
		const db = freshDb();
		await warm(
			db,
			{
				"https://p1.invalid/v1": [
					{
						id: "claude-speaker",
						supported_endpoints: ["/messages"],
					},
					{
						id: "open-speaker",
						supported_endpoints: ["/chat/completions", "/responses"],
					},
				],
			},
			["p1"],
		);
		invalidateCatalog();
		const catalog = await loadCatalog(
			hostWith([{ baseURL: "https://p1.invalid/v1", id: "p1" }], []),
			db,
		);
		const claude = catalog.families.find(
			(entry) => entry.targets[0]?.modelID === "claude-speaker",
		);
		const open = catalog.families.find(
			(entry) => entry.targets[0]?.modelID === "open-speaker",
		);
		expect(claude?.package).toBe("@opencode/ai/providers/anthropic-compatible");
		expect(open?.package).toBe(PACKAGE);
	});
});

describe("where a target's window came from", () => {
	test("a declared limit says so", async () => {
		const db = freshDb();
		const host = [
			model("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
				context: 200_000,
			}),
		];
		invalidateCatalog();
		const catalog = await loadCatalog(ctxWith(host), db);
		const route = catalog.families[0]?.targets.find(
			(target) => target.providerID === "p1",
		);
		expect(route?.contextSource).toBe("declared");
	});

	test("a provider that publishes no window leaves it unknown", async () => {
		const db = freshDb();
		await warm(
			db,
			{ "https://p1.invalid/v1": [{ id: "deepseek-v4.1-flash" }] },
			["p1"],
		);
		invalidateCatalog();
		const catalog = await loadCatalog(
			hostWith([{ baseURL: "https://p1.invalid/v1", id: "p1" }], []),
			db,
		);
		const route = catalog.families[0]?.targets[0];
		expect(route?.context).toBeUndefined();
		expect(route?.contextSource).toBe("unknown");
	});
});

describe("borrowing a window from an identical model", () => {
	const providers = [
		{ baseURL: "https://p1.invalid/v1", id: "p1" },
		{ baseURL: "https://p2.invalid/v1", id: "p2" },
	];

	async function twoSides(db: Database, second = 1_000_000) {
		await warm(
			db,
			{
				"https://p1.invalid/v1": [{ id: "deepseek-v4.1-flash" }],
				"https://p2.invalid/v1": [
					{ context_length: second, id: "deepseek-v4.1-flash" },
				],
			},
			["p1", "p2"],
		);
		invalidateCatalog();
		return loadCatalog(hostWith(providers, []), db);
	}

	test("the switch is what turns it on", async () => {
		const db = freshDb();
		const before = await twoSides(db);
		expect(
			before.families[0]?.targets.find((t) => t.providerID === "p1")
				?.contextSource,
		).toBe("unknown");

		setAssumeWindows(db, "p1", true);
		invalidateCatalog();
		const after = await loadCatalog(hostWith(providers, []), db);
		const borrowed = after.families[0]?.targets.find(
			(target) => target.providerID === "p1",
		);
		expect(borrowed?.context).toBe(1_000_000);
		expect(borrowed?.contextSource).toBe("assumed");
		expect(borrowed?.assumedFrom).toBe("p2");
	});

	test("the smallest published answer wins", async () => {
		const db = freshDb();
		saveAccount(db, "p3", "a", { key: "k3", type: "api" });
		await warm(
			db,
			{
				"https://p1.invalid/v1": [{ id: "deepseek-v4.1-flash" }],
				"https://p2.invalid/v1": [
					{ context_length: 1_048_000, id: "deepseek-v4.1-flash" },
				],
				"https://p3.invalid/v1": [
					{ context_length: 1_000_000, id: "deepseek-v4.1-flash" },
				],
			},
			["p1", "p2", "p3"],
		);
		setAssumeWindows(db, "p1", true);
		invalidateCatalog();
		const catalog = await loadCatalog(
			hostWith(
				[...providers, { baseURL: "https://p3.invalid/v1", id: "p3" }],
				[],
			),
			db,
		);
		const borrowed = catalog.families[0]?.targets.find(
			(target) => target.providerID === "p1",
		);
		expect(borrowed?.context).toBe(1_000_000);
		expect(borrowed?.assumedFrom).toBe("p3");
	});

	test("a tee or free spelling is not the same model", async () => {
		const db = freshDb();
		await warm(
			db,
			{
				"https://p1.invalid/v1": [{ id: "deepseek-v4.1-flash-tee" }],
				"https://p2.invalid/v1": [
					{ context_length: 1_000_000, id: "deepseek-v4.1-flash" },
				],
			},
			["p1", "p2"],
		);
		setAssumeWindows(db, "p1", true);
		invalidateCatalog();
		const catalog = await loadCatalog(hostWith(providers, []), db);
		const tee = catalog.families.find((family) =>
			family.targets.some((target) => target.modelID.endsWith("-tee")),
		);
		expect(
			tee?.targets.find((target) => target.providerID === "p1")?.contextSource,
		).toBe("unknown");
	});
});
