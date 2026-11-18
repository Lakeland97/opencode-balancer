import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	getAccount,
	readLimitedUntil,
	saveAccount,
	setAccountEnabled,
} from "../core/accounts";
import { setBalancingEnabled } from "../core/priority";
import { migrate } from "../core/schema";
import { invalidateCatalog, loadCatalog } from "../server/connectors";
import { forgetRoutingMemory, registerHooks } from "../server/hooks";
import {
	modelUnavailable,
	noteModelUnavailable,
} from "../server/model-availability";
import { sessionTokens } from "../server/route-memory";
import { chooseRoute } from "../server/routing";

const PACKAGE = "@opencode/ai/providers/openai-compatible";

type HookCallback = (event: Record<string, unknown>) => unknown;

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

const apiAuth = (key: string) => ({ key, type: "api" as const });

// The balance belongs to the client now, so it outlives a case: one test's
// failover would otherwise be the next test's starting point.
beforeEach(() => {
	forgetRoutingMemory();
});

/**
 * A row with two providers, both healthy, so a failure has somewhere to go and
 * the account it left behind can be inspected.
 */
async function harness() {
	const db = freshDb();
	const registry: Record<string, HookCallback> = {};
	const compactions: string[] = [];
	const synthetic: { description?: string; sessionID: string; text: string }[] =
		[];
	const ctx = {
		model: {
			list: async () => ({
				data: ["p1", "p2"].map((providerID) => ({
					enabled: true,
					limit: { context: 200_000, output: 4096 },
					modelID: "alpha-1",
					name: "Alpha",
					package: PACKAGE,
					providerID,
					settings: { baseURL: `https://${providerID}.invalid/v1` },
					type: "chat",
				})),
			}),
		},
		session: {
			compact: async ({ sessionID }: { sessionID: string }) => {
				compactions.push(sessionID);
			},
			hook: async (name: string, callback: HookCallback) => {
				registry[name] = callback;
				return { dispose: async () => {} };
			},
			synthetic: async (input: {
				description?: string;
				sessionID: string;
				text: string;
			}) => {
				synthetic.push(input);
				return {};
			},
		},
	};
	saveAccount(db, "p1", "a", apiAuth("sk-1"));
	saveAccount(db, "p2", "a", apiAuth("sk-2"));
	setBalancingEnabled(db, true);
	invalidateCatalog();
	await registerHooks({ ctx: ctx as unknown as Context, db });
	return { compactions, db, registry, synthetic };
}

const row = (sessionID: string) => ({
	agent: "build",
	headers: {} as Record<string, string>,
	kind: "primary",
	model: { id: "alpha-1", providerID: "balancer" },
	sessionID,
});

function failed(sessionID: string, error: unknown) {
	return {
		agent: "build",
		attempt: 1,
		decision: { delay: 1_000, retry: false },
		error,
		model: { id: "alpha-1", providerID: "balancer" },
		sessionID,
	};
}

async function familyOf(db: Database) {
	const catalog = await loadCatalog(
		{
			model: {
				list: async () => ({
					data: ["p1", "p2"].map((providerID) => ({
						enabled: true,
						limit: { context: 200_000, output: 4096 },
						modelID: "alpha-1",
						name: "Alpha",
						package: PACKAGE,
						providerID,
						settings: { baseURL: `https://${providerID}.invalid/v1` },
						type: "chat",
					})),
				}),
			},
		} as never,
		db,
	);
	const family = catalog.families.find((entry) => entry.key === "alpha-1");
	if (!family) throw new Error("row missing");
	return family;
}

describe("a slow target", () => {
	test("a timeout moves on without parking the account", async () => {
		const { db, registry } = await harness();
		const first = row("slow");
		await registry["model.request"](first);
		expect(first.headers.authorization).toBe("Bearer sk-1");

		const timeout = Object.assign(
			new Error("The operation was aborted due to timeout"),
			{ name: "TimeoutError" },
		);
		await registry.retry(failed("slow", timeout));

		// The credential answered nothing wrong: the next call will use it.
		expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeUndefined();
		expect(getAccount(db, "p1", "a")?.failures).toBe(0);
		// ... and nothing was written off for the model either.
		expect(modelUnavailable(db, "p1", "alpha-1")).toBe(false);

		// The row still moves: the request that just timed out should not be
		// handed back to the same target.
		const second = row("slow");
		await registry["model.request"](second);
		expect(second.headers.authorization).toBe("Bearer sk-2");
	});
});

describe("a model the provider will not serve", () => {
	test("a plan refusal marks the pair and leaves the account alone", async () => {
		const { db, registry } = await harness();
		await registry["model.request"](row("entitlement"));

		await registry.retry(
			failed("entitlement", {
				message:
					"tier_request_kind_not_entitled: this model is not on your plan",
				status: 403,
			}),
		);

		// The key is fine; only this model is.
		expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeUndefined();
		expect(modelUnavailable(db, "p1", "alpha-1")).toBe(true);
		// The other provider is untouched and still routable.
		expect(modelUnavailable(db, "p2", "alpha-1")).toBe(false);
		expect(chooseRoute(db, await familyOf(db))?.providerID).toBe("p2");
	});

	test("the mark lapses, so a plan change is picked up without a restart", async () => {
		const { db } = await harness();
		const { noteModelUnavailable } = await import(
			"../server/model-availability"
		);
		noteModelUnavailable(db, "p1", "alpha-1", 0);
		expect(modelUnavailable(db, "p1", "alpha-1", 0)).toBe(true);
		// Half an hour later the pair is tried again.
		expect(modelUnavailable(db, "p1", "alpha-1", 31 * 60_000)).toBe(false);
	});
});

describe("a conversation larger than the model", () => {
	test("an overflow compacts instead of reaching the session", async () => {
		const { compactions, db, registry } = await harness();
		await registry["model.request"](row("overflow"));

		const event = failed("overflow", {
			message:
				"Your request resulted in more tokens than this model's maximum context length allows.",
			status: 400,
		});
		await registry.retry(event);

		expect(compactions).toEqual(["overflow"]);
		expect(event.decision).toEqual({ delay: 0, retry: true });
		// The provider is not blamed for the size of the conversation.
		expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeUndefined();
		expect(readLimitedUntil(db, "p1", "a")).toBeUndefined();
		// What was measured no longer describes the prompt after a compaction.
		expect(sessionTokens(db, "overflow")).toBeUndefined();
	});
});

describe("the prompt on the wire", () => {
	test("a request records the size it is about to send", async () => {
		const { db, registry } = await harness();
		const body = JSON.stringify({
			messages: [{ content: "x".repeat(40_000), role: "user" }],
			model: "alpha-1",
		});
		const event = {
			...row("measured"),
			request: new Request("https://balancer.invalid/v1/messages", {
				body,
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		};
		await registry["http.request"](event);

		// The host never trims a balancer row, so this figure is what stops a
		// conversation from being handed to a model too small to hold it.
		expect(sessionTokens(db, "measured")).toBeGreaterThan(9_000);
	});
});

describe("a row nothing can serve", () => {
	test("a row whose every target is marked still sends to one, so the answer is real", async () => {
		const { db, registry, synthetic } = await harness();

		// Every target has refused this exact model — the shape a plan refusal or
		// a price gate leaves behind. Those marks are the balancer's guess about
		// the world, not the provider's answer to this request, and leaving the
		// call pointed at the stub made it fail as an unreachable host. The row
		// therefore sends to a real target anyway: the call either answers or the
		// provider refuses it in its own words.
		noteModelUnavailable(db, "p1", "alpha-1");
		noteModelUnavailable(db, "p2", "alpha-1");

		const event = row("marked");
		await registry["model.request"](event);

		expect(event.headers.authorization).toBe("Bearer sk-1");
		expect(synthetic).toHaveLength(0);
	});

	test("with no credential at all the conversation is told why", async () => {
		const { db, registry, synthetic } = await harness();
		setAccountEnabled(db, "p1", "a", false);
		setAccountEnabled(db, "p2", "a", false);

		const event = row("unroutable");
		await registry["model.request"](event);

		// Nothing can be attempted, so the call is left alone — the host fails it
		// as an ordinary model error, not a thrown plugin error — and the reason
		// is in the session.
		expect(event.headers).toEqual({});
		expect(synthetic).toHaveLength(1);
		expect(synthetic[0].sessionID).toBe("unroutable");
		expect(synthetic[0].text).toContain("nothing can serve alpha-1");
		expect(synthetic[0].text).toContain("no enabled credential");
	});

	test("one message per attempt, so a retry does not fill the transcript", async () => {
		const { db, registry, synthetic } = await harness();
		setAccountEnabled(db, "p1", "a", false);
		setAccountEnabled(db, "p2", "a", false);

		await registry["model.request"](row("twice"));
		await registry["model.request"](row("twice"));

		// One synthetic message per request: a second attempt is a second thing
		// the user asked for, not a loop the plugin is running.
		expect(synthetic).toHaveLength(2);
		expect(synthetic.every((entry) => entry.sessionID === "twice")).toBe(true);
	});
});
