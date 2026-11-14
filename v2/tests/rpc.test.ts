import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
	getAccount,
	orderedAccounts,
	saveAccount,
	setAccountFreeOnly,
} from "../core/accounts";
import { getStoredChain } from "../core/chains";
import { migrate } from "../core/schema";
import { balancerDefinition } from "../rpc";
import { invalidateCatalog } from "../server/connectors";
import { markRateLimited } from "../server/request-state";
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
		await rpc.contextPercent({});
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

/** A client whose provider list answers normally. */
function workingCtx(data: unknown[]) {
	return {
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
}

/** The registered handlers, as a client would call them. */
async function handlers(db: Database, data: unknown[] = connectors) {
	return (await registerBalancerRpc({
		ctx: workingCtx(data),
		db,
	})) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
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
	return (await registerBalancerRpc({ ctx, db })) as unknown as Record<
		string,
		(input: unknown) => Promise<unknown>
	>;
}

beforeEach(() => {
	invalidateCatalog();
});

describe("chain rpc", () => {
	test("chains carries targets and no window of its own", async () => {
		const db = freshDb();
		const rpc = await handlers(db);
		const listed = (await rpc.chains({})) as {
			rows: {
				key: string;
				targets: { percent: number }[];
			}[];
		};
		const row = listed.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(row).toBeDefined();
		// The window is the same 1M declaration whatever the row holds, so a
		// row has no window of its own to report; only the shares matter.
		expect(row && "context" in row).toBe(false);
		expect(row && "trip" in row).toBe(false);
		expect(row?.targets.length).toBe(1);
		expect(row?.targets[0]?.percent).toBe(0);

		await rpc.chainAdd({
			key: "deepseek-v4.1-flash",
			modelID: "mimo-v2.6-flash",
			providerID: "p2",
		});
		const after = (await rpc.chains({})) as {
			rows: { key: string; targets: { percent: number }[] }[];
		};
		const mixed = after.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(mixed?.targets.length).toBe(2);
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

	test("priority lists one row per credential, in the routing order", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "b", { key: "k3", type: "api" });
		const rpc = await handlers(db);

		const listed = (await rpc.priority({})) as {
			entries: { alias: string; providerID: string; position: number }[];
		};
		expect(
			listed.entries.map((row) => `${row.providerID}/${row.alias}`),
		).toEqual(["p1/a", "p2/a", "p1/b"]);
		expect(listed.entries.map((row) => row.position)).toEqual([0, 1, 2]);
	});

	test("the switches apply to one credential, not its provider", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "b", { key: "k3", type: "api" });
		const rpc = await handlers(db);

		await rpc.setFreeOnly({ alias: "b", enabled: true, providerID: "p1" });
		await rpc.setEnabled({ alias: "b", enabled: false, providerID: "p1" });

		expect(getAccount(db, "p1", "b")?.freeOnly).toBe(true);
		expect(getAccount(db, "p1", "b")?.disabled).toBe(true);
		expect(getAccount(db, "p1", "a")?.freeOnly).toBe(false);
		expect(getAccount(db, "p1", "a")?.disabled).toBe(false);
	});

	test("an arrow moves one credential through the order", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		await rpc.move({ alias: "a", direction: "down", providerID: "p1" });

		expect(
			orderedAccounts(db).map((row) => `${row.providerID}/${row.alias}`),
		).toEqual(["p2/a", "p1/a"]);
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

	test("a free-only credential shows the model it will actually use", async () => {
		const db = freshDb();
		saveAccount(db, "p3", "a", { key: "k3", type: "api" });
		const rpc = (await registerBalancerRpc({
			ctx: workingCtx([
				...connectors,
				model("p1", "deepseek-v4.1-flash-free", 200_000),
				model("p3", "deepseek-v4.1-flash", 1_000_000),
			]),
			db,
		})) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
		setAccountFreeOnly(db, "p1", "a", true);
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

	test("a parked free-only credential still shows the free model it will use", async () => {
		const db = freshDb();
		saveAccount(db, "p3", "a", { key: "k3", type: "api" });
		const rpc = (await registerBalancerRpc({
			ctx: workingCtx([
				...connectors,
				model("p1", "deepseek-v4.1-flash-free", 200_000),
				model("p3", "deepseek-v4.1-flash", 1_000_000),
			]),
			db,
		})) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
		setAccountFreeOnly(db, "p1", "a", true);
		invalidateCatalog();
		// The row must keep saying which model this target sends while its key
		// sits out a park: the park is temporary and the `state` marker already
		// reports it, so losing the free spelling here is losing the answer to
		// "is a free model in play".
		markRateLimited(db, "p1", "a");

		const listed = (await rpc.chains({})) as {
			rows: {
				key: string;
				targets: { modelID: string; providerID: string; resolved: string }[];
			}[];
		};
		const row = listed.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		const free = row?.targets.find((target) => target.providerID === "p1");
		expect(free?.resolved).toBe("deepseek-v4.1-flash-free");
	});

	test("a free-only credential whose provider has no free spelling keeps the paid id", async () => {
		const db = freshDb();
		const rpc = (await registerBalancerRpc({
			ctx: workingCtx(connectors),
			db,
		})) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
		setAccountFreeOnly(db, "p1", "a", true);
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
		// p1 offers no `-free` spelling, so free-only cannot substitute and the
		// id it was configured with is the one the row must show.
		expect(paid?.resolved).toBe("deepseek-v4.1-flash");
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

describe("log rpc", () => {
	test("log reports what the balancer did and can be cleared", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		await rpc.setBalancing({ enabled: false });
		const listed = (await rpc.log({})) as {
			entries: { kind: string; text: string }[];
		};
		expect(
			listed.entries.some((entry) => entry.text.includes("balancing off")),
		).toBe(true);

		await rpc.clearLog({});
		const cleared = (await rpc.log({})) as { entries: unknown[] };
		expect(cleared.entries).toEqual([]);
	});
});

describe("context percent rpc", () => {
	test("the global share reads as its default until it is set", async () => {
		const rpc = await handlers(freshDb());

		const state = (await rpc.contextPercent({})) as { percent: number };
		expect(state.percent).toBe(20);
	});

	test("a set share is reported back and an empty value restores the default", async () => {
		const rpc = await handlers(freshDb());

		const set = (await rpc.setContextPercent({ value: "35" })) as {
			ok: boolean;
		};
		expect(set.ok).toBe(true);
		const after = (await rpc.contextPercent({})) as { percent: number };
		expect(after.percent).toBe(35);

		await rpc.setContextPercent({ value: "" });
		const cleared = (await rpc.contextPercent({})) as { percent: number };
		expect(cleared.percent).toBe(20);
	});

	test("a trailing percent sign is accepted", async () => {
		const rpc = await handlers(freshDb());

		const set = (await rpc.setContextPercent({ value: "45%" })) as {
			ok: boolean;
		};
		expect(set.ok).toBe(true);
		const after = (await rpc.contextPercent({})) as { percent: number };
		expect(after.percent).toBe(45);
	});

	test("a share outside 1% to 100% is refused and nothing is stored", async () => {
		const rpc = await handlers(freshDb());

		for (const value of ["0%", "-5", "abc", "101"]) {
			const result = (await rpc.setContextPercent({ value })) as {
				message: string;
				ok: boolean;
			};
			expect(result.ok).toBe(false);
			expect(result.message.length).toBeGreaterThan(0);
		}
		const after = (await rpc.contextPercent({})) as { percent: number };
		expect(after.percent).toBe(20);
	});

	test("a per-model share is reported on that target only", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		const set = (await rpc.setTargetPercent({
			key: "deepseek-v4.1-flash",
			providerID: "p1",
			value: "50",
		})) as { ok: boolean };
		expect(set.ok).toBe(true);

		const listed = (await rpc.chains({})) as {
			rows: {
				key: string;
				targets: { percent: number; providerID: string }[];
			}[];
		};
		const row = listed.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		const target = row?.targets.find((entry) => entry.providerID === "p1");
		expect(target?.percent).toBe(50);

		// Clearing it hands the model back to the global share.
		await rpc.setTargetPercent({
			key: "deepseek-v4.1-flash",
			providerID: "p1",
			value: "",
		});
		const after = (await rpc.chains({})) as {
			rows: { key: string; targets: { percent: number }[] }[];
		};
		expect(
			after.rows.find((entry) => entry.key === "deepseek-v4.1-flash")
				?.targets[0]?.percent,
		).toBe(0);
	});

	test("a per-model share outside 1% to 100% is refused", async () => {
		const rpc = await handlers(freshDb());

		const refused = (await rpc.setTargetPercent({
			key: "deepseek-v4.1-flash",
			providerID: "p1",
			value: "lots",
		})) as { message: string; ok: boolean };
		expect(refused.ok).toBe(false);
		expect(refused.message.length).toBeGreaterThan(0);

		const listed = (await rpc.chains({})) as {
			rows: { key: string; targets: { percent: number }[] }[];
		};
		expect(
			listed.rows.find((entry) => entry.key === "deepseek-v4.1-flash")
				?.targets[0]?.percent,
		).toBe(0);
	});
});
