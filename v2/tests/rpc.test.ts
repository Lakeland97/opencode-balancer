import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveAccount } from "../core/accounts";
import { getStoredChain } from "../core/chains";
import { setFreeOnly } from "../core/priority";
import { migrate } from "../core/schema";
import { balancerDefinition } from "../rpc";
import { invalidateCatalog } from "../server/connectors";
import { registerBalancerRpc } from "../server/rpc";

type Schema = {
	items?: Schema;
	properties?: Record<string, Schema>;
	required?: string[];
};

/**
 * The RPC layer validates handler output against this contract, so a key that
 * is required but never declared makes every call fail at runtime.
 */
function assertContractIsWellFormed(schema: Schema, path: string) {
	for (const key of schema.required ?? []) {
		if (!schema.properties?.[key]) {
			throw new Error(`${path}: required ${key} is not declared`);
		}
	}
	for (const [key, value] of Object.entries(schema.properties ?? {})) {
		assertContractIsWellFormed(value, `${path}.${key}`);
	}
	if (schema.items) assertContractIsWellFormed(schema.items, `${path}[]`);
}

describe("contract", () => {
	test("every declared requirement exists and validates against output", async () => {
		for (const [name, method] of Object.entries(
			balancerDefinition.methods as Record<string, { output: Schema }>,
		)) {
			assertContractIsWellFormed(method.output, name);
		}

		// The shapes the panel reads are also checked against real output.
		const db = freshDb();
		const rpc = await handlers(db);
		await rpc.chains({});
		await rpc.list({});
		await rpc.priority({});
	});
});

const PACKAGE = "@opencode/ai/providers/openai-compatible";
const OTHER_PACKAGE = "@opencode/ai/providers/anthropic-compatible";

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
	context: number,
	pkg = PACKAGE,
	name = modelID,
) {
	return {
		enabled: true,
		limit: { context, output: 4096 },
		modelID,
		name,
		package: pkg,
		providerID,
		settings: { baseURL: `https://${providerID}.invalid/v1` },
		type: "chat",
	};
}

const connectors = [
	model("p1", "deepseek-v4.1-flash", 1_000_000, PACKAGE, "DeepSeek V4.1 Flash"),
	model("p2", "mimo-v2.6-flash", 200_000, PACKAGE, "MiMo V2.6 Flash"),
];

/** The registered handlers, as a client would call them. */
async function handlers(
	db: Database,
	data: unknown[] = connectors,
	options: { configPath?: string; refresh?: () => Promise<void> | void } = {},
) {
	const ctx = {
		model: { list: async () => ({ data }) },
		provider: {
			list: async () => ({
				data: [{ id: "p1", name: "Provider One" }],
			}),
		},
		rpc: {
			register: async (
				_definition: unknown,
				registered: Record<string, unknown>,
			) => ({
				...registered,
				events: { emit: async () => {} },
			}),
		},
	} as never;

	return (await registerBalancerRpc({
		buffer: { kind: "percent", percent: 0.75 },
		...options,
		ctx,
		db,
	})) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
}

/** A config file on disk, so the writer has something real to edit. */
function tempConfig(text: string) {
	const dir = mkdtempSync(join(tmpdir(), "balancer-rpc-"));
	const file = join(dir, "opencode.json");
	writeFileSync(file, text);
	return file;
}

/** A client whose provider list throws, as the Desktop panel's does. */
async function handlersFailingProviderList(db: Database) {
	const ctx = {
		model: { list: async () => ({ data: connectors }) },
		provider: {
			list: async () => {
				throw new Error("no provider catalogue in this context");
			},
		},
		rpc: {
			register: async (
				_definition: unknown,
				registered: Record<string, unknown>,
			) => ({
				...registered,
				events: { emit: async () => {} },
			}),
		},
	} as never;
	return (await registerBalancerRpc({
		buffer: { kind: "percent", percent: 0.75 },
		ctx,
		db,
	})) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
}

beforeEach(() => {
	invalidateCatalog();
});

describe("chain rpc", () => {
	test("chains reports stored order and the declared window", async () => {
		const db = freshDb();
		const rpc = await handlers(db);
		const listed = (await rpc.chains({})) as {
			rows: { declaredContext: number; key: string; targets: unknown[] }[];
		};
		const row = listed.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(row).toBeDefined();
		// One 1M target at 75% declares 4M. The number is the lever the host
		// compacts against, not a claim about what the model holds.
		expect(row?.declaredContext).toBe(4_000_000);
		expect(row?.targets.length).toBe(1);

		await rpc.chainAdd({
			key: "deepseek-v4.1-flash",
			modelID: "mimo-v2.6-flash",
			providerID: "p2",
		});
		const after = (await rpc.chains({})) as {
			rows: {
				declaredContext: number;
				key: string;
				context: number;
				targets: unknown[];
			}[];
		};
		const mixed = after.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(mixed?.targets.length).toBe(2);
		expect(mixed?.context).toBe(200_000);
		expect(mixed?.declaredContext).toBe(800_000);
	});

	test("chainAdd appends a target and refuses a foreign wire format", async () => {
		const db = freshDb();
		const rpc = await handlers(db, [
			...connectors,
			model("p2", "claude-opus-5-5", 200_000, OTHER_PACKAGE),
		]);

		const added = (await rpc.chainAdd({
			key: "deepseek-v4.1-flash",
			modelID: "mimo-v2.6-flash",
			providerID: "p2",
		})) as { ok: boolean };
		expect(added.ok).toBe(true);
		expect(getStoredChain(db, "deepseek-v4.1-flash")?.targets).toHaveLength(2);

		const refused = (await rpc.chainAdd({
			key: "deepseek-v4.1-flash",
			modelID: "claude-opus-5-5",
			providerID: "p2",
		})) as { message: string; ok: boolean };
		expect(refused.ok).toBe(false);
		expect(refused.message).toContain("already");
	});

	test("chainMove rejects an unknown row", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		const reply = (await rpc.chainMove({
			direction: "up",
			key: "no-such-row",
			providerID: "p1",
		})) as { ok: boolean };
		expect(reply.ok).toBe(false);
	});

	test("priority carries provider names", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		const listed = (await rpc.priority({})) as {
			entries: { name: string; providerID: string }[];
		};
		expect(listed.entries[0]?.name).toBe("Provider One");
	});

	test("priority still lists providers when names are unavailable", async () => {
		const db = freshDb();
		const rpc = await handlersFailingProviderList(db);

		const listed = (await rpc.priority({})) as {
			entries: { freeOnly: boolean; name: string; providerID: string }[];
		};
		const entry = listed.entries.find((row) => row.providerID === "p1");
		expect(entry?.name).toBe("p1");
		expect(entry?.freeOnly).toBe(false);
	});

	test("chainCreate starts a custom row from one model", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		const created = (await rpc.chainCreate({
			modelID: "mimo-v2.6-flash",
			providerID: "p2",
		})) as { key?: string; ok: boolean };

		expect(created.ok).toBe(true);
		expect(created.key).toBe("mimo-v2.6-flash");
		const stored = getStoredChain(db, "mimo-v2.6-flash");
		expect(stored?.targets.map((target) => target.providerID)).toEqual(["p2"]);
		expect(stored?.label).toBe("MiMo V2.6 Flash");

		const listed = (await rpc.chains({})) as {
			rows: { key: string; stored: boolean; targets: unknown[] }[];
		};
		const row = listed.rows.find((entry) => entry.key === "mimo-v2.6-flash");
		expect(row?.stored).toBe(true);
		expect(row?.targets.length).toBe(1);
	});

	test("a free-only provider shows the model it will actually use", async () => {
		const db = freshDb();
		saveAccount(db, "p3", "a", { key: "k3", type: "api" });
		const ctx = {
			model: {
				list: async () => ({
					data: [
						...connectors,
						model("p1", "deepseek-v4.1-flash-free", 200_000),
						model("p3", "deepseek-v4.1-flash", 1_000_000),
					],
				}),
			},
			provider: { list: async () => ({ data: [] }) },
			rpc: {
				register: async (
					_definition: unknown,
					registered: Record<string, unknown>,
				) => ({ ...registered, events: { emit: async () => {} } }),
			},
		} as never;
		const rpc = (await registerBalancerRpc({
			buffer: { kind: "percent", percent: 0.75 },
			ctx,
			db,
		})) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
		setFreeOnly(db, "p1", true);
		invalidateCatalog();

		const listed = (await rpc.chains({})) as {
			rows: {
				key: string;
				targets: { modelID: string; providerID: string; resolved: string }[];
			}[];
		};
		const row = listed.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		const paid = row?.targets.find((target) => target.providerID === "p1");
		expect(paid?.modelID).toBe("deepseek-v4.1-flash");
		expect(paid?.resolved).toBe("deepseek-v4.1-flash-free");
	});

	test("chainModels lists only routable models for a provider", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		const listed = (await rpc.chainModels({ providerID: "p2" })) as {
			models: { modelID: string }[];
		};
		expect(listed.models.map((entry) => entry.modelID)).toEqual([
			"mimo-v2.6-flash",
		]);
	});
});

describe("buffer rpc", () => {
	test("reports the usable share, not the host's reserve", async () => {
		const file = tempConfig(
			'{\n  // keep this\n  "compaction": { "buffer": "75%" }\n}',
		);
		const rpc = await handlers(freshDb(), connectors, { configPath: file });

		const state = (await rpc.buffer({})) as { path: string; value: string };
		expect(state.value).toBe("25%");
		expect(state.path).toBe(file);
	});

	test("setBuffer stores the reserve that leaves the share asked for", async () => {
		const file = tempConfig(
			'{\n  // keep this\n  "compaction": { "buffer": "75%" }\n}',
		);
		const rpc = await handlers(freshDb(), connectors, { configPath: file });

		const result = (await rpc.setBuffer({ value: "5%" })) as { ok: boolean };
		expect(result.ok).toBe(true);

		const text = readFileSync(file, "utf8");
		expect(text).toContain("// keep this");
		expect(text).toContain('"buffer": "95%"');
		expect(((await rpc.buffer({})) as { value: string }).value).toBe("5%");
	});

	test("setBuffer refuses a value the host would reject", async () => {
		const file = tempConfig('{"compaction":{"buffer":"75%"}}');
		const rpc = await handlers(freshDb(), connectors, { configPath: file });

		const result = (await rpc.setBuffer({ value: "0%" })) as {
			message: string;
			ok: boolean;
		};

		expect(result.ok).toBe(false);
		expect(readFileSync(file, "utf8")).toContain('"buffer":"75%"');
	});

	test("setBuffer asks the host to re-read its models", async () => {
		const file = tempConfig('{"compaction":{"buffer":"75%"}}');
		let refreshed = 0;
		const rpc = await handlers(freshDb(), connectors, {
			configPath: file,
			refresh: async () => {
				refreshed++;
			},
		});

		await rpc.setBuffer({ value: "5%" });

		expect(refreshed).toBe(1);
	});
});
