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
		await rpc.contextLimit({});
		await rpc.rebalance({});
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
				limit: string;
				targets: unknown[];
			}[];
		};
		const row = listed.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(row).toBeDefined();
		// The window is the same 1M declaration whatever the row holds, so a
		// row has no window of its own to report; only the limits matter.
		expect(row && "context" in row).toBe(false);
		expect(row && "trip" in row).toBe(false);
		expect(row?.targets.length).toBe(1);
		// The limit belongs to the row, not to a credential.
		expect(row?.limit).toBe("");

		await rpc.chainAdd({
			key: "deepseek-v4.1-flash",
			modelID: "mimo-v2.6-flash",
			providerID: "p2",
		});
		const after = (await rpc.chains({})) as {
			rows: { key: string; targets: unknown[] }[];
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

describe("context limit rpc", () => {
	test("the global limit reads as its default until it is set", async () => {
		const rpc = await handlers(freshDb());

		expect(await rpc.contextLimit({})).toEqual({ value: "" });
	});

	test("a set limit is reported back as typed, and empty restores the default", async () => {
		const rpc = await handlers(freshDb());

		const share = (await rpc.setContextLimit({ value: "35%" })) as {
			ok: boolean;
		};
		expect(share.ok).toBe(true);
		expect(await rpc.contextLimit({})).toEqual({ value: "35%" });

		// The same field takes a size in thousands, kept as typed so the panel
		// reads back what was written.
		const size = (await rpc.setContextLimit({ value: "200" })) as {
			ok: boolean;
		};
		expect(size.ok).toBe(true);
		expect(await rpc.contextLimit({})).toEqual({ value: "200" });

		await rpc.setContextLimit({ value: "" });
		expect(await rpc.contextLimit({})).toEqual({ value: "" });
	});

	test("the buffer round-trips, and what it cannot read it refuses", async () => {
		const rpc = await handlers(freshDb());
		expect(await rpc.contextBuffer({})).toEqual({
			enforce: "always",
			value: "",
		});

		const set = (await rpc.setContextBuffer({ value: "20" })) as {
			ok: boolean;
		};
		expect(set.ok).toBe(true);
		expect(await rpc.contextBuffer({})).toEqual({
			enforce: "always",
			value: "20",
		});

		// A refused value leaves the working one in place rather than clearing it.
		const refused = (await rpc.setContextBuffer({ value: "lots" })) as {
			message: string;
			ok: boolean;
		};
		expect(refused.ok).toBe(false);
		expect(refused.message.length).toBeGreaterThan(0);
		expect(await rpc.contextBuffer({})).toEqual({
			enforce: "always",
			value: "20",
		});

		await rpc.setContextBuffer({ value: "" });
		expect(await rpc.contextBuffer({})).toEqual({
			enforce: "always",
			value: "",
		});
	});

	test("when the buffer is enforced round-trips, and a third state is refused", async () => {
		const rpc = await handlers(freshDb());
		expect(((await rpc.contextBuffer({})) as { enforce: string }).enforce).toBe(
			"always",
		);

		const necessary = (await rpc.setBufferEnforce({
			value: "necessary",
		})) as { ok: boolean };
		expect(necessary.ok).toBe(true);
		// It changes the rule, not the value: an empty field stays empty.
		expect(await rpc.contextBuffer({})).toEqual({
			enforce: "necessary",
			value: "",
		});

		const refused = (await rpc.setBufferEnforce({ value: "sometimes" })) as {
			message: string;
			ok: boolean;
		};
		expect(refused.ok).toBe(false);
		expect(refused.message.length).toBeGreaterThan(0);
		expect(((await rpc.contextBuffer({})) as { enforce: string }).enforce).toBe(
			"necessary",
		);

		await rpc.setBufferEnforce({ value: "always" });
		expect(((await rpc.contextBuffer({})) as { enforce: string }).enforce).toBe(
			"always",
		);
	});

	test("a limit is outside what it may be, and nothing is stored", async () => {
		const rpc = await handlers(freshDb());

		for (const value of ["0%", "0", "-5", "abc", "101%", "2m"]) {
			const result = (await rpc.setContextLimit({ value })) as {
				message: string;
				ok: boolean;
			};
			expect(result.ok).toBe(false);
			expect(result.message.length).toBeGreaterThan(0);
		}
		expect(await rpc.contextLimit({})).toEqual({ value: "" });
	});

	test("a model's limit is reported on its own row", async () => {
		const db = freshDb();
		const rpc = await handlers(db);

		const set = (await rpc.setModelLimit({
			key: "deepseek-v4.1-flash",
			value: "50%",
		})) as { ok: boolean };
		expect(set.ok).toBe(true);

		const listed = (await rpc.chains({})) as {
			rows: {
				key: string;
				limit: string;
				targets: { limit?: string; providerID: string }[];
			}[];
		};
		const row = listed.rows.find(
			(entry) => entry.key === "deepseek-v4.1-flash",
		);
		expect(row?.limit).toBe("50%");
		// One limit for the model, so no credential carries a private one.
		expect(row?.targets.every((target) => target.limit === undefined)).toBe(
			true,
		);
		expect(row?.targets.length).toBeGreaterThan(0);

		// Clearing it hands the model back to the global limit.
		await rpc.setModelLimit({ key: "deepseek-v4.1-flash", value: "" });
		const after = (await rpc.chains({})) as {
			rows: { key: string; limit: string }[];
		};
		expect(
			after.rows.find((entry) => entry.key === "deepseek-v4.1-flash")?.limit,
		).toBe("");
	});

	test("a model's own size is accepted and kept as typed", async () => {
		const rpc = await handlers(freshDb());

		const set = (await rpc.setModelLimit({
			key: "deepseek-v4.1-flash",
			value: "200",
		})) as { ok: boolean };
		expect(set.ok).toBe(true);

		const listed = (await rpc.chains({})) as {
			rows: { key: string; limit: string }[];
		};
		expect(
			listed.rows.find((entry) => entry.key === "deepseek-v4.1-flash")?.limit,
		).toBe("200");
	});

	test("a limit outside what it may be is refused, and changes nothing", async () => {
		const rpc = await handlers(freshDb());

		const refused = (await rpc.setModelLimit({
			key: "deepseek-v4.1-flash",
			value: "lots",
		})) as { message: string; ok: boolean };
		expect(refused.ok).toBe(false);
		expect(refused.message.length).toBeGreaterThan(0);

		const listed = (await rpc.chains({})) as {
			rows: { key: string; limit: string }[];
		};
		expect(
			listed.rows.find((entry) => entry.key === "deepseek-v4.1-flash")?.limit,
		).toBe("");
	});
});

describe("rebalance rpc", () => {
	test("the window reads as unset until it is typed, and empty restores it", async () => {
		const rpc = await handlers(freshDb());
		expect(await rpc.rebalance({})).toEqual({ value: "" });

		const set = (await rpc.setRebalance({ value: "2h" })) as { ok: boolean };
		expect(set.ok).toBe(true);
		expect(await rpc.rebalance({})).toEqual({ value: "2h" });

		// Clearing the field puts the built-in window back, so the panel's
		// placeholder is what describes the behaviour again.
		await rpc.setRebalance({ value: "" });
		expect(await rpc.rebalance({})).toEqual({ value: "" });
	});

	test("what is not a duration is refused and changes nothing", async () => {
		const rpc = await handlers(freshDb());
		await rpc.setRebalance({ value: "90m" });

		for (const value of ["5", "5 hours", "five", "h5"]) {
			const refused = (await rpc.setRebalance({ value })) as {
				message: string;
				ok: boolean;
			};
			expect(refused.ok).toBe(false);
			expect(refused.message.length).toBeGreaterThan(0);
		}
		expect(await rpc.rebalance({})).toEqual({ value: "90m" });
	});

	test("switching the window off says so, in words that match", async () => {
		const rpc = await handlers(freshDb());
		const off = (await rpc.setRebalance({ value: "0" })) as {
			message: string;
			ok: boolean;
		};
		expect(off.ok).toBe(true);
		expect(off.message).toContain("change to the order");
		expect(await rpc.rebalance({})).toEqual({ value: "0" });
	});
});
