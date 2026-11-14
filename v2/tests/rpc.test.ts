import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { saveAccount } from "../core/accounts";
import { getStoredChain } from "../core/chains";
import { migrate } from "../core/schema";
import { invalidateCatalog } from "../server/connectors";
import { registerBalancerRpc } from "../server/rpc";

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
async function handlers(db: Database, data: unknown[] = connectors) {
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
		// One 1M target, buffer 75%: declare 4M so compaction fires at 1M.
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
