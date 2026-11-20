import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";

import {
	getAccount,
	readLimitedReason,
	readLimitedUntil,
	saveAccount,
	setActiveAccount,
} from "../core/accounts";
import { readCompactPromptTokens, setModelLimit } from "../core/context";
import { listEvents } from "../core/events";
import { setBalancingEnabled } from "../core/priority";
import { setRebalance, setRebalanceAuto } from "../core/rebalance";
import { migrate } from "../core/schema";
import { now } from "../core/time";
import { invalidateCatalog } from "../server/connectors";
import {
	balancerTargetsFor,
	forgetRoutingMemory,
	nextRebalanceAt,
	ontoTarget,
	registerHooks,
} from "../server/hooks";
import { markRateLimited } from "../server/request-state";
import { noteSessionTokens } from "../server/route-memory";
import { registerBalancerRpc } from "../server/rpc";

const PROVIDER = "anthropic";
const MODEL = { id: "claude-test", providerID: PROVIDER };
const PACKAGE = "@opencode/ai/providers/openai-compatible";
const BALANCER = { id: "deepseek-v4.1-flash", providerID: "balancer" };

type HookCallback = (event: Record<string, unknown>) => unknown;

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

const apiAuth = (key: string) => ({ key, type: "api" as const });

// Routing memory is the client's and outlives a case, so each test starts from
// an untouched order: one case's failover must not be the next one's start.
beforeEach(() => {
	forgetRoutingMemory();
});

async function setup() {
	const db = freshDb();
	const registry: Record<string, HookCallback> = {};
	const ctx = {
		session: {
			hook: async (name: string, callback: HookCallback) => {
				registry[name] = callback;
				return { dispose: async () => {} };
			},
		},
	};

	await registerHooks({ ctx: ctx as unknown as Context, db });
	return { db, registry };
}

function requestEvent(sessionID: string, request: Request) {
	return {
		agent: "build",
		kind: "chat",
		model: MODEL,
		request,
		sessionID,
	};
}

function newRequest() {
	return new Request("https://api.example.test/v1/messages", {
		headers: { authorization: "Bearer native" },
		method: "POST",
	});
}

function retryEvent(sessionID: string, decision: Record<string, unknown>) {
	return {
		agent: "build",
		attempt: 1,
		decision,
		error: { status: 429 },
		model: MODEL,
		sessionID,
	};
}

describe("http.request hook", () => {
	test("injects the active account's api key into the authorization header", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));

		const event = requestEvent("request-active", newRequest());
		await registry["http.request"](event);

		expect(event.request.headers.get("authorization")).toBe(
			"Bearer sk-primary",
		);
	});

	test("injects the alternative account's key when the active account is rate limited", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		saveAccount(db, PROVIDER, "backup", apiAuth("sk-backup"));
		setActiveAccount(db, PROVIDER, "primary");
		markRateLimited(db, PROVIDER, "primary");

		const event = requestEvent("request-failover", newRequest());
		await registry["http.request"](event);

		expect(event.request.headers.get("authorization")).toBe("Bearer sk-backup");
	});

	test("a compaction request's instruction sets the reserve's floor", async () => {
		const { db, registry } = await setup();
		// Before anything is watched, the floor is the figure measured from the
		// host's own prompt.
		expect(readCompactPromptTokens(db)).toBe(1_000);

		const event = {
			...requestEvent(
				"compact-measure",
				new Request("https://api.example.test/v1/messages", {
					body: JSON.stringify({
						messages: [{ content: "x".repeat(8_000), role: "user" }],
					}),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
			),
			kind: "compaction",
		};
		await registry["http.request"](event);

		// This hook is the only place the figure is learned: the size of the
		// instruction the summary request carries, rounded to a thousand.
		expect(readCompactPromptTokens(db)).toBe(2_000);
	});

	test("an ordinary request is not measured", async () => {
		const { db, registry } = await setup();
		const request = new Request("https://api.example.test/v1/messages", {
			body: JSON.stringify({
				messages: [{ content: "x".repeat(8_000), role: "user" }],
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		await registry["http.request"](requestEvent("not-a-compaction", request));

		expect(readCompactPromptTokens(db)).toBe(1_000);
	});
});

describe("http.response hook", () => {
	test("marks the tracked account rate limited on 429", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));

		const request = newRequest();
		const event = requestEvent("response-429", request);
		await registry["http.request"](event);

		const before = now();
		await registry["http.response"]({
			...event,
			response: new Response(null, { status: 429 }),
		});

		const account = getAccount(db, PROVIDER, "primary");
		expect(account?.rateLimitedUntil).toBeGreaterThan(before);
		expect(account?.failures).toBe(1);
	});

	test("a refusal that names its reset leaves the instant for the panel", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		setBalancingEnabled(db, true);

		const event = requestEvent("response-quota", newRequest());
		await registry["http.request"](event);
		const at = now();
		// The host's typed quota error carries the words; they are what the panel
		// turns into a time, and this is the hook where they first arrive.
		await registry.retry({
			...retryEvent("response-quota", { delay: 1_000, retry: false }),
			error: {
				message: "usage limit reached; resets in 12d 23h",
				retryAfterMs: 60_000,
			},
		});

		expect(readLimitedUntil(db, PROVIDER, "primary")).toBeGreaterThan(
			at + 12 * 24 * 60 * 60_000,
		);
		expect(readLimitedReason(db, PROVIDER, "primary")).toContain("12d");
	});

	test("leaves accounts untouched on 200", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));

		const event = requestEvent("response-200", newRequest());
		await registry["http.request"](event);
		await registry["http.response"]({
			...event,
			response: new Response(null, { status: 200 }),
		});

		const account = getAccount(db, PROVIDER, "primary");
		expect(account?.rateLimitedUntil).toBeUndefined();
		expect(account?.failures).toBe(0);
	});
});

describe("retry hook", () => {
	test("retries immediately on 429 when balancing is on and an alternative exists", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		saveAccount(db, PROVIDER, "backup", apiAuth("sk-backup"));
		setActiveAccount(db, PROVIDER, "primary");
		setBalancingEnabled(db, true);

		await registry["http.request"](
			requestEvent("retry-failover", newRequest()),
		);

		const event = retryEvent("retry-failover", { delay: 1_500, retry: false });
		await registry.retry(event);

		expect(event.decision).toEqual({ delay: 0, retry: true });
	});

	test("a billing refusal the host wrapped as a bad request still fails over", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		saveAccount(db, PROVIDER, "backup", apiAuth("sk-backup"));
		setActiveAccount(db, PROVIDER, "primary");
		setBalancingEnabled(db, true);

		await registry["http.request"](requestEvent("retry-billing", newRequest()));

		// The host has no specific mapping for this refusal, so it raises
		// `AI.Error.InvalidRequest` with a 400 and the provider's own words. The
		// wrapper used to be read as "the request's fault", which handed the spent
		// account's refusal to the session while a working one sat beside it.
		const event = {
			...retryEvent("retry-billing", { delay: 1_000, retry: false }),
			error: {
				message:
					"You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
				name: "InvalidRequest",
				status: 400,
			},
		};
		await registry.retry(event);

		expect(event.decision).toEqual({ delay: 0, retry: true });
		expect(readLimitedReason(db, PROVIDER, "primary")).toContain(
			"insufficient credits",
		);
	});

	test("a failure the host does not put into words still says why", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		saveAccount(db, PROVIDER, "backup", apiAuth("sk-backup"));
		setActiveAccount(db, PROVIDER, "primary");
		setBalancingEnabled(db, true);

		await registry["http.request"](requestEvent("retry-silent", newRequest()));
		// The host raised a typed error with a status but no text of its own,
		// so the status is the only evidence the panel can be given.
		await registry.retry(retryEvent("retry-silent", {}));

		expect(readLimitedReason(db, PROVIDER, "primary")).toBe("HTTP 429");
	});

	test("leaves the decision unchanged when no alternative account exists", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		setBalancingEnabled(db, true);

		await registry["http.request"](
			requestEvent("retry-no-alternative", newRequest()),
		);

		const decision = { delay: 2_500, retry: false };
		const event = retryEvent("retry-no-alternative", decision);
		await registry.retry(event);

		expect(event.decision).toEqual({ delay: 2_500, retry: false });
	});

	test("a refusal nothing else can answer ends the host's retries", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		setBalancingEnabled(db, true);

		await registry["http.request"](requestEvent("retry-settled", newRequest()));

		// The host treats a 429 as worth retrying and will ask again every half
		// second or so. Nothing else can answer this row, so every one of those
		// asks costs a real refusal from the provider: a spent account produced
		// a hundred of them in a minute. The decision is settled here instead, so
		// the turn ends once with the provider's own words.
		const event = retryEvent("retry-settled", { delay: 500, retry: true });
		await registry.retry(event);

		expect(event.decision).toEqual({ delay: 500, retry: false });
	});
	test("leaves the decision unchanged when balancing is off", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		saveAccount(db, PROVIDER, "backup", apiAuth("sk-backup"));
		setActiveAccount(db, PROVIDER, "primary");
		setBalancingEnabled(db, false);

		await registry["http.request"](
			requestEvent("retry-balancing-off", newRequest()),
		);

		const decision = { delay: 3_000, retry: false };
		const event = retryEvent("retry-balancing-off", decision);
		await registry.retry(event);

		expect(event.decision).toEqual({ delay: 3_000, retry: false });
	});

	test("the host's attempt count is not what decides whether to fail over", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		saveAccount(db, PROVIDER, "backup", apiAuth("sk-backup"));
		setActiveAccount(db, PROVIDER, "primary");
		setBalancingEnabled(db, true);

		await registry["http.request"](
			requestEvent("retry-late-attempt", newRequest()),
		);

		// The host's counter climbs for the life of the session and the balancer
		// never resets it, so it must not be what turns failover off. What counts
		// is how many targets this session has tried since its last answer.
		const event = {
			...retryEvent("retry-late-attempt", { delay: 1_500, retry: false }),
			attempt: 99,
		};
		await registry.retry(event);

		expect(event.decision).toEqual({ delay: 0, retry: true });
	});

	test("a failure handed to the session is written down, with the branch that did it", async () => {
		const { db, registry } = await setup();
		// One account, so there is nowhere to move to and the failure is the
		// session's. That reason used to live only in the plugin's memory, which
		// a reload wipes; it is now in the store, where it outlives the run.
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		setBalancingEnabled(db, true);

		await registry["http.request"](
			requestEvent("retry-recorded", newRequest()),
		);
		await registry.retry(retryEvent("retry-recorded", {}));

		const recorded = listEvents(db).find(
			(entry) => entry.type === "error_reached_session",
		);
		expect(recorded?.metadata.branch).toBe("no alternative");
		expect(recorded?.providerID).toBe(PROVIDER);
		expect(recorded?.alias).toBe("primary");
	});
});

describe("the session's target", () => {
	async function routedSetup() {
		const db = freshDb();
		const registry: Record<string, HookCallback> = {};
		const ctx = {
			model: {
				list: async () => ({
					data: [
						{
							enabled: true,
							limit: { context: 200_000, output: 4096 },
							modelID: "deepseek-v4.1-flash",
							name: "DeepSeek V4.1 Flash",
							package: PACKAGE,
							providerID: "p1",
							settings: { baseURL: "https://p1.invalid/v1" },
							type: "chat",
						},
					],
				}),
			},
			session: {
				hook: async (name: string, callback: HookCallback) => {
					registry[name] = callback;
					return { dispose: async () => {} };
				},
			},
		};
		saveAccount(db, "p1", "a", apiAuth("sk-1"));
		invalidateCatalog();
		await registerHooks({ ctx: ctx as unknown as Context, db });
		return { db, registry };
	}

	test("a conversation larger than every window still sends somewhere", async () => {
		const { db, registry } = await routedSetup();
		// The only target publishes 200k and the conversation is past it. Every
		// rung that respects windows declines, and the request used to stay on
		// `balancer.invalid` — which does not resolve, so the host reported a
		// network error and re-sent four times. One attempt the provider can
		// refuse in its own words is strictly more useful than that.
		noteSessionTokens(db, "big-1", 900_000);
		const event = {
			agent: "build",
			headers: {} as Record<string, string>,
			kind: "chat",
			model: BALANCER,
			sessionID: "big-1",
		};
		await registry["model.request"](event);
		expect((event as { baseURL?: string }).baseURL).toBe(
			"https://p1.invalid/v1",
		);
	});

	test("a routed call records the row and the window it went through", async () => {
		const { db, registry } = await routedSetup();
		await registry["model.request"]({
			agent: "build",
			headers: {} as Record<string, string>,
			kind: "chat",
			model: BALANCER,
			sessionID: "routed-1",
		});

		// This is what the compaction watcher measures against: the row decides
		// which per-model share applies, and the window is the ceiling the share
		// is clamped by.
		expect(balancerTargetsFor(db, "routed-1")).toEqual([
			{
				context: 200_000,
				familyKey: "deepseek-v4.1-flash",
				providerID: "p1",
			},
		]);
	});

	test("a session that never routed here has nothing to compact", async () => {
		const { db } = await routedSetup();
		expect(balancerTargetsFor(db, "never-routed")).toEqual([]);
	});
});

describe("two models in one session", () => {
	/** Two models, each offered by providers of its own. */
	async function twoModels() {
		const db = freshDb();
		const registry: Record<string, HookCallback> = {};
		const offered = (providerID: string, modelID: string, context: number) => ({
			enabled: true,
			limit: { context, output: 4096 },
			modelID,
			name: modelID,
			package: PACKAGE,
			providerID,
			settings: { baseURL: `https://${providerID}.invalid/v1` },
			type: "chat",
		});
		const ctx = {
			model: {
				list: async () => ({
					data: [
						// `alpha` is offered by two providers, so its row has a real
						// choice in it. `beta` is offered by one, which is the case
						// that has no alternative to fall back to.
						offered("p1", "alpha-1", 200_000),
						offered("p2", "alpha-1", 200_000),
						offered("q", "beta-1", 100_000),
					],
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
			session: {
				hook: async (name: string, callback: HookCallback) => {
					registry[name] = callback;
					return { dispose: async () => {} };
				},
			},
		};
		saveAccount(db, "p1", "a", apiAuth("sk-1"));
		saveAccount(db, "p2", "a", apiAuth("sk-2"));
		saveAccount(db, "q", "a", apiAuth("sk-3"));
		setBalancingEnabled(db, true);
		invalidateCatalog();
		await registerHooks({ ctx: ctx as unknown as Context, db });
		return { db, registry };
	}

	const row = (sessionID: string, modelID: string) => ({
		agent: "build",
		headers: {} as Record<string, string>,
		kind: "primary",
		model: { id: modelID, providerID: "balancer" },
		sessionID,
	});

	/** Serve from the head of `alpha`, then fail it: `p1` is parked. */
	async function failOverAlpha(
		registry: Record<string, HookCallback>,
		sessionID: string,
	) {
		const event = row(sessionID, "alpha-1");
		await registry["model.request"](event);
		expect(event.headers.authorization).toBe("Bearer sk-1");
		await registry.retry({
			...retryEvent(sessionID, { delay: 1_000, retry: false }),
			model: { id: "alpha-1", providerID: "balancer" },
		});
	}

	test("a timeout worded as an abort moves to the next account", async () => {
		const { registry } = await twoModels();

		const first = row("timeout-abort", "alpha-1");
		await registry["model.request"](first);
		expect(first.headers.authorization).toBe("Bearer sk-1");

		// What a stream cut for taking too long can look like: the host says
		// "aborted", which used to be read as the user stopping the turn.
		const timeout = Object.assign(
			new Error("The operation was aborted due to timeout"),
			{ name: "TimeoutError" },
		);
		await registry.retry({
			...retryEvent("timeout-abort", { delay: 1_000, retry: false }),
			error: timeout,
			model: { id: "alpha-1", providerID: "balancer" },
		});

		const next = row("timeout-abort", "alpha-1");
		await registry["model.request"](next);
		expect(next.headers.authorization).toBe("Bearer sk-2");
	});

	test("a slow request keeps its account past the trail's freshness window", async () => {
		const start = Date.now();
		try {
			const { db, registry } = await twoModels();

			const first = { ...row("slow-bound", "alpha-1"), request: newRequest() };
			await registry["model.request"](first);
			await registry["http.request"](first);
			expect(first.request.headers.get("authorization")).toBe("Bearer sk-1");

			// The attempt is still running six minutes later. The account is
			// parked meanwhile, so only the route bound to this request can
			// keep its retry on `p1` instead of selecting a new account.
			markRateLimited(db, "p1", "a", 10 * 60_000);
			setSystemTime(start + 6 * 60_000);

			const retry = { ...row("slow-bound", "alpha-1"), request: newRequest() };
			await registry["http.request"](retry);
			expect(retry.request.headers.get("authorization")).toBe("Bearer sk-1");
		} finally {
			setSystemTime();
		}
	});

	test("each model keeps its own balance, so a switch does not reset one", async () => {
		const start = Date.now();
		const { registry } = await twoModels();
		await failOverAlpha(registry, "two-models");

		// Settled on `p2` while its own trail remembers `p1`.
		const second = row("two-models", "alpha-1");
		await registry["model.request"](second);
		expect(second.headers.authorization).toBe("Bearer sk-2");

		// The other model answers from its own provider. With one slot per
		// session this is what used to overwrite `alpha`'s pin, so the line after
		// it went back to `alpha`'s head for no reason.
		const other = row("two-models", "beta-1");
		await registry["model.request"](other);
		expect(other.headers.authorization).toBe("Bearer sk-3");

		// `p1`'s park has expired, so only the pin can explain staying on `p2`.
		// The pin is still inside its own freshness window.
		setSystemTime(start + 90_000);
		try {
			const back = row("two-models", "alpha-1");
			await registry["model.request"](back);
			expect(back.headers.authorization).toBe("Bearer sk-2");
		} finally {
			setSystemTime();
		}
	});

	test("a model whose only provider is parked is still tried", async () => {
		const { registry } = await twoModels();

		// `beta` is offered by `q` alone, and `q` fails: there is no alternative
		// in the row, so the session is told — that is the documented behaviour.
		const first = row("only-provider", "beta-1");
		await registry["model.request"](first);
		expect(first.headers.authorization).toBe("Bearer sk-3");
		await registry.retry({
			...retryEvent("only-provider", { delay: 1_000, retry: false }),
			model: { id: "beta-1", providerID: "balancer" },
		});

		// The next request must still reach `q`. The row holds only providers that
		// offer the model, so the park is protecting nothing here, and leaving the
		// call unrouted sends the session to the stub instead: a transport error
		// that says nothing about what happened.
		const again = row("only-provider", "beta-1");
		await registry["model.request"](again);
		expect(again.headers.authorization).toBe("Bearer sk-3");
	});

	test("an HTTP retry stays on the account its model request chose", async () => {
		const { registry } = await twoModels();

		const first = { ...row("http-retry", "alpha-1"), request: newRequest() };
		await registry["model.request"](first);
		await registry["http.request"](first);
		expect(first.request.headers.get("authorization")).toBe("Bearer sk-1");

		// The endpoint rejects the call, so `p1` is parked. The host's HTTP
		// stack retries the same model request; routing it again here is what
		// turns one failure into errors from two providers.
		await registry["http.response"]({
			...first,
			response: new Response(null, { status: 429 }),
		});
		const retry = { ...row("http-retry", "alpha-1"), request: newRequest() };
		await registry["http.request"](retry);

		expect(retry.request.headers.get("authorization")).toBe("Bearer sk-1");
	});

	test("an auxiliary call does not move the primary's failure to its own account", async () => {
		const { db, registry } = await twoModels();

		// The conversation is served by `p1`, which is then parked: a typed error
		// arrives later, and by then the host may have done housekeeping.
		const primary = { ...row("aux-race", "alpha-1"), request: newRequest() };
		await registry["model.request"](primary);
		await registry["http.request"](primary);
		expect(primary.headers.authorization).toBe("Bearer sk-1");
		markRateLimited(db, "p1", "a", 60_000, "insufficient balance");

		// While `p1` is parked, the host titles the session. An auxiliary call
		// must not rebalance the row: it stays on the credential the primary
		// attempt went to, so the failure below is still charged there.
		const title = { ...row("aux-race", "alpha-1"), kind: "title" };
		await registry["model.request"](title);
		expect(title.headers.authorization).toBe("Bearer sk-1");

		// The primary attempt's typed error arrives after the title routed.
		await registry.retry({
			...retryEvent("aux-race", { delay: 1_000, retry: false }),
			error: { message: "OpenCode Go monthly usage limit reached" },
			model: { id: "alpha-1", providerID: "balancer" },
		});

		expect(getAccount(db, "p2", "a")?.rateLimitedUntil).toBeUndefined();
		expect(readLimitedReason(db, "p1", "a")).toContain("monthly usage limit");
	});

	test("an auxiliary call does not decide where the conversation is cut", async () => {
		const { db, registry } = await twoModels();

		// The conversation is on `alpha`, whose connector holds 200k.
		await registry["model.request"](row("mixed-kinds", "alpha-1"));

		// The host titles the session with another model — a 100k one. Measuring
		// the conversation against that window would cut it four times too early.
		await registry["model.request"]({
			...row("mixed-kinds", "beta-1"),
			kind: "title",
		});

		expect(balancerTargetsFor(db, "mixed-kinds")).toEqual([
			{ context: 200_000, familyKey: "alpha-1", providerID: "p1" },
		]);
	});

	test("both models the conversation ran are on record, not just the last", async () => {
		const { db, registry } = await twoModels();
		await registry["model.request"](row("two-rows", "alpha-1"));
		await registry["model.request"](row("two-rows", "beta-1"));

		const rows = balancerTargetsFor(db, "two-rows");
		expect(rows.map((entry) => entry.familyKey).sort()).toEqual([
			"alpha-1",
			"beta-1",
		]);
	});
});

describe("a balance that has gone stale", () => {
	const FIVE_HOURS = 5 * 60 * 60_000;

	/** Two providers offering one model, so the order is a real choice. */
	async function twoProviders() {
		const db = freshDb();
		const registry: Record<string, HookCallback> = {};
		const offered = (providerID: string) => ({
			enabled: true,
			limit: { context: 200_000, output: 4096 },
			modelID: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			package: PACKAGE,
			providerID,
			settings: { baseURL: `https://${providerID}.invalid/v1` },
			type: "chat",
		});
		const ctx = {
			model: { list: async () => ({ data: [offered("p1"), offered("p2")] }) },
			rpc: {
				register: async (
					_definition: unknown,
					registered: Record<string, unknown>,
				) => ({
					...registered,
					events: { emit: async () => {} },
				}),
			},
			session: {
				hook: async (name: string, callback: HookCallback) => {
					registry[name] = callback;
					return { dispose: async () => {} };
				},
			},
		};
		saveAccount(db, "p1", "a", apiAuth("sk-1"));
		saveAccount(db, "p2", "a", apiAuth("sk-2"));
		setBalancingEnabled(db, true);
		invalidateCatalog();
		await registerHooks({ ctx: ctx as unknown as Context, db });
		return { ctx: ctx as unknown as Context, db, registry };
	}

	/** Serve from the head, then fail it: the trail now says "use p2". */
	async function failOverFromTheHead(
		registry: Record<string, HookCallback>,
		sessionID: string,
	) {
		const event = {
			agent: "build",
			headers: {} as Record<string, string>,
			kind: "chat",
			model: BALANCER,
			sessionID,
		};
		await registry["model.request"](event);
		expect(event.headers.authorization).toBe("Bearer sk-1");
		await registry.retry({
			...retryEvent(sessionID, { delay: 1_000, retry: false }),
			model: BALANCER,
		});
	}

	const request = (sessionID: string) => ({
		agent: "build",
		headers: {} as Record<string, string>,
		kind: "chat",
		model: BALANCER,
		sessionID,
	});

	test("past the window the row checks the head of the order again", async () => {
		const start = Date.now();
		const { registry } = await twoProviders();
		await failOverFromTheHead(registry, "stale-window");

		// Five hours on, the check is due: p1's park is long expired, so the head
		// of the order can serve again rather than the row staying on the target
		// the failure left it on.
		setSystemTime(start + FIVE_HOURS + 60_000);
		try {
			const event = request("stale-window");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-1");
		} finally {
			setSystemTime();
		}
	});

	test("inside the window the row keeps the target it settled on", async () => {
		const start = Date.now();
		const { registry } = await twoProviders();
		await failOverFromTheHead(registry, "fresh-window");

		// p1's park has expired here too, so only the row's balance can explain p2
		// being chosen: the window has not elapsed, so the head is not checked.
		setSystemTime(start + FIVE_HOURS - 60_000);
		try {
			const event = request("fresh-window");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-2");
		} finally {
			setSystemTime();
		}
	});

	test("an active conversation still reaches the check, because traffic does not move the clock", async () => {
		const start = Date.now();
		const { db, registry } = await twoProviders();
		await failOverFromTheHead(registry, "busy-window");
		// The clock was seeded by the first route and is not the answer clock. The
		// seed is real time, a millisecond or two after `start` was read.
		const seeded = nextRebalanceAt(db, start);
		expect(seeded).toBeGreaterThanOrEqual(start + FIVE_HOURS);
		expect(seeded).toBeLessThan(start + FIVE_HOURS + 5_000);

		// Four hours of real traffic on the expensive target. The old idle timer
		// restamped the trail on every request, so this request itself is what
		// used to push the check out to nine hours.
		setSystemTime(start + 4 * 60 * 60_000);
		try {
			const busy = request("busy-window");
			await registry["model.request"](busy);
			expect(busy.headers.authorization).toBe("Bearer sk-2");
			// The same moment as before the request: traffic did not move it.
			expect(nextRebalanceAt(db)).toBe(seeded);
		} finally {
			setSystemTime();
		}

		// One hour and a minute after the seed, with the conversation still live,
		// the check fires and returns the row to the cheaper head.
		setSystemTime(start + FIVE_HOURS + 60_000);
		try {
			const event = request("busy-window");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-1");
		} finally {
			setSystemTime();
		}
	});

	test("a check restarts the clock, so the next one is a full window later", async () => {
		const start = Date.now();
		const { db, registry } = await twoProviders();
		await failOverFromTheHead(registry, "next-check");
		setSystemTime(start + FIVE_HOURS + 60_000);
		try {
			const event = request("next-check");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-1");
			expect(nextRebalanceAt(db)).toBe(start + 2 * FIVE_HOURS + 60_000);
		} finally {
			setSystemTime();
		}
	});

	test("a change to the order starts every session over at once", async () => {
		const start = Date.now();
		const { registry } = await twoProviders();
		await failOverFromTheHead(registry, "order-change");

		// p1's park has expired here but the trail has not: without the reset this
		// session would answer on p2 for another hour. Dropping the trail and the
		// pin makes the next request derive its route from the order as it now
		// stands. The park itself is left alone — it is the provider's clock, not
		// our memory — which is why the head can serve again only once that
		// expires.
		setSystemTime(start + FIVE_HOURS - 60_000);
		try {
			forgetRoutingMemory();
			const event = request("order-change");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-1");
		} finally {
			setSystemTime();
		}
	});

	test("a window switched off keeps the trail however long the session waits", async () => {
		const start = Date.now();
		const { db, registry } = await twoProviders();
		// A length is set as well as the switch turned off, so this can only pass
		// if the switch is what gates the clock: the length alone would age the
		// trail out long before ten hours are up.
		setRebalance(db, "2h");
		setRebalanceAuto(db, false);
		await failOverFromTheHead(registry, "window-off");

		// Ten hours of traffic: past any quota window, and past the built-in
		// default twice over. Off means nothing but a change to the order moves
		// a row.
		setSystemTime(start + 10 * 60 * 60_000);
		try {
			const event = request("window-off");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-2");
		} finally {
			setSystemTime();
		}
	});

	test("a wider window holds the trail past the built-in default", async () => {
		const start = Date.now();
		const { db, registry } = await twoProviders();
		setRebalance(db, "10h");
		await failOverFromTheHead(registry, "wide-window");

		// Six hours: past the built-in five, inside the ten that were asked for.
		setSystemTime(start + 6 * 60 * 60_000);
		try {
			const event = request("wide-window");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-2");
		} finally {
			setSystemTime();
		}
	});

	test("a narrower window goes stale sooner than the built-in default", async () => {
		const start = Date.now();
		const { db, registry } = await twoProviders();
		setRebalance(db, "2h");
		await failOverFromTheHead(registry, "narrow-window");

		// Three hours: inside the built-in five, past the two that were asked for,
		// and p1's park expired long ago, so only the trail could explain p2.
		setSystemTime(start + 3 * 60 * 60_000);
		try {
			const event = request("narrow-window");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-1");
		} finally {
			setSystemTime();
		}
	});

	test("a failover moves every session on the row, because the balance is the client's", async () => {
		const { registry } = await twoProviders();
		await failOverFromTheHead(registry, "client-a");

		// A second conversation, never routed before this moment. Kept per
		// session, it would start at the head and spend the account the first
		// conversation just found exhausted; the client already knows better.
		const second = request("client-b");
		await registry["model.request"](second);
		expect(second.headers.authorization).toBe("Bearer sk-2");
	});

	test("a row's target after an answer is the target every session uses", async () => {
		const { registry } = await twoProviders();
		await failOverFromTheHead(registry, "answered-a");

		// The answer lands on p2. The row is understood to be served there now, so
		// a different conversation that has never asked is sent to the same target
		// rather than starting from the head and re-testing p1.
		const answered = { ...request("answered-a"), request: newRequest() };
		await registry["model.request"](answered);
		await registry["http.request"](answered);
		await registry["http.response"]({
			...answered,
			response: new Response(null, { status: 200 }),
		});

		const other = request("answered-b");
		await registry["model.request"](other);
		expect(other.headers.authorization).toBe("Bearer sk-2");
	});

	test("a pick serves on the very next request", async () => {
		const { ctx, db, registry } = await twoProviders();
		await failOverFromTheHead(registry, "picked");

		// The pick is the retry a park waits for: it clears p1's park, drops the
		// trail that named p2, and restarts the window from now. So the next
		// request goes to p1 with no clock movement at all — which is what makes
		// selecting a credential feel like it did something.
		const rpc = (await registerBalancerRpc({ ctx, db })) as unknown as Record<
			string,
			(input: unknown) => Promise<unknown>
		>;
		const picked = (await rpc.use({ alias: "a", providerID: "p1" })) as {
			ok: boolean;
		};
		expect(picked.ok).toBe(true);

		const event = request("picked");
		await registry["model.request"](event);
		expect(event.headers.authorization).toBe("Bearer sk-1");
	});

	test("a pick on a provider that is not first leaves the order alone", async () => {
		const { ctx, db, registry } = await twoProviders();

		// p1 holds the head of the order and p2 holds one credential of its own.
		// Picking p2 selects that credential inside p2; it must not drag p2 in
		// front of p1, because that would change which provider serves every
		// other model too. Until the order moves, p1 still serves.
		const rpc = (await registerBalancerRpc({ ctx, db })) as unknown as Record<
			string,
			(input: unknown) => Promise<unknown>
		>;
		const picked = (await rpc.use({ alias: "a", providerID: "p2" })) as {
			ok: boolean;
		};
		expect(picked.ok).toBe(true);

		const event = request("picked-second");
		await registry["model.request"](event);
		expect(event.headers.authorization).toBe("Bearer sk-1");
	});
});

describe("a refusal the session never sees", () => {
	/** Two providers offering one model, so a refusal has somewhere to go. */
	async function offered() {
		const db = freshDb();
		const registry: Record<string, HookCallback> = {};
		const one = (providerID: string) => ({
			enabled: true,
			limit: { context: 200_000, output: 4096 },
			modelID: "alpha-1",
			name: "Alpha One",
			package: PACKAGE,
			providerID,
			settings: { baseURL: `https://${providerID}.invalid/v1` },
			type: "chat",
		});
		const ctx = {
			model: { list: async () => ({ data: [one("p1"), one("p2")] }) },
			rpc: {
				register: async (
					_definition: unknown,
					registered: Record<string, unknown>,
				) => ({
					...registered,
					events: { emit: async () => {} },
				}),
			},
			session: {
				hook: async (name: string, callback: HookCallback) => {
					registry[name] = callback;
					return { dispose: async () => {} };
				},
			},
		};
		saveAccount(db, "p1", "a", apiAuth("sk-1"));
		saveAccount(db, "p2", "a", apiAuth("sk-2"));
		setBalancingEnabled(db, true);
		invalidateCatalog();
		await registerHooks({ ctx: ctx as unknown as Context, db });
		return { db, registry };
	}

	/** The stub every test below answers through, restored afterwards. */
	function stubFetch(
		answer: (request: Request) => Response | Promise<Response>,
	) {
		const original = globalThis.fetch;
		const calls: Request[] = [];
		globalThis.fetch = (async (input: Request | URL | string) => {
			const request = input instanceof Request ? input : new Request(input);
			calls.push(request.clone());
			return answer(request);
		}) as typeof fetch;
		return {
			calls,
			restore() {
				globalThis.fetch = original;
			},
		};
	}

	const answer = () =>
		new Response(JSON.stringify({ ok: true }), {
			headers: { "content-type": "application/json" },
			status: 200,
		});

	/**
	 * The request as the host hands it over: addressed to the row's own stub,
	 * because the model hook already set `baseURL` to the connector it chose.
	 */
	const call = (sessionID: string) => ({
		agent: "build",
		headers: {} as Record<string, string>,
		kind: "primary",
		model: { id: "alpha-1", providerID: "balancer" },
		request: new Request("https://balancer.invalid/v1/messages", {
			body: JSON.stringify({ messages: [], model: "alpha-1" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		}),
		sessionID,
	});

	/** Route the call, then answer it with the status given. */
	async function refuse(
		registry: Record<string, HookCallback>,
		sessionID: string,
		status: number,
	) {
		const event = {
			...call(sessionID),
			response: undefined as Response | undefined,
		};
		await registry["model.request"](event);
		await registry["http.request"](event);
		// The response hook replaces this on the same object, which is how the
		// session is handed the answer it should see.
		event.response = new Response(null, { status });
		await registry["http.response"](event);
		return event as typeof event & { response: Response };
	}

	test("a spent account's refusal is answered by the next target instead", async () => {
		const { db, registry } = await offered();
		const fetched = stubFetch(answer);
		try {
			// `p1` is spent. Before this, the 429 was handed to the host, which
			// classified it as deterministic, put its words in the conversation and
			// stopped the turn — with `p2` sitting healthy behind it.
			const event = await refuse(registry, "inside-the-call", 429);

			expect(event.response.status).toBe(200);
			// The retry really went out, with the second credential and the second
			// provider's own URL: nothing about it is the first attempt's. The
			// catalogue probes each connector makes are not part of this call.
			// The catalogue probes each connector makes are not part of this call.
			const sent = fetched.calls.filter(
				(request) => !request.url.endsWith("/models"),
			);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.headers.get("authorization")).toBe("Bearer sk-2");
			expect(sent[0]?.url).toBe("https://p2.invalid/v1/messages");
			// And the spent one is parked, so the next request does not try it again.
			expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeDefined();
		} finally {
			fetched.restore();
		}
	});

	test("a conversation too large for the target is cut before it is sent", async () => {
		const { db, registry } = await offered();
		// A window far below the conversation, so the cut is large enough to be
		// obvious in the body. The session's measured size is what routing uses to
		// see that no target can hold it whole.
		setModelLimit(db, "alpha-1", "5k");
		noteSessionTokens(db, "too-large", 250_000);
		const long = (label: string) => label + "x".repeat(8_000);
		const event = {
			...call("too-large"),
			request: new Request("https://balancer.invalid/v1/messages", {
				body: JSON.stringify({
					messages: [
						{ content: "Be brief.", role: "system" },
						{ content: long("one"), role: "user" },
						{ content: long("two"), role: "assistant" },
						{ content: long("three"), role: "user" },
						{ content: long("four"), role: "assistant" },
						{ content: long("five"), role: "user" },
						{ content: long("six"), role: "assistant" },
					],
					model: "alpha-1",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		};

		await registry["http.request"](event);

		const sent = (await event.request.clone().json()) as {
			messages: { content: string; role: string }[];
		};
		// The older turns are gone, the instructions and the newest turn remain,
		// and the cut is on a turn boundary rather than mid-conversation.
		expect(sent.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
		]);
		expect(sent.messages[1]?.content).toBe(long("five"));
		expect(sent.messages[2]?.content).toBe(long("six"));
	});

	test("the retried body names the target's own model id", async () => {
		const { registry } = await offered();
		const fetched = stubFetch(answer);
		try {
			const body = JSON.stringify({ messages: [], model: "alpha-1" });
			const event = {
				...call("own-id"),
				request: new Request("https://balancer.invalid/v1/messages", {
					body,
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
			};
			await registry["model.request"](event);
			await registry["http.request"](event);
			await registry["http.response"]({
				...event,
				response: new Response(null, { status: 429 }),
			});

			const sent = fetched.calls.find(
				(request) => !request.url.endsWith("/models"),
			);
			expect(sent).toBeDefined();
			const parsed = JSON.parse(await sent!.clone().text()) as {
				model: string;
			};
			// The id in the retried body comes from the target, not from the
			// request that failed.
			expect(parsed.model).toBe("alpha-1");
		} finally {
			fetched.restore();
		}
	});

	test("when every target refuses, the session sees a real refusal", async () => {
		const { registry } = await offered();
		const fetched = stubFetch(() => new Response(null, { status: 429 }));
		try {
			const event = await refuse(registry, "all-spent", 429);

			// Both providers were tried inside the call, and both were spent. There
			// is no honest answer left to give, so the session gets a provider's
			// own refusal rather than a turn that pretends it succeeded.
			expect(
				fetched.calls.filter((request) => !request.url.endsWith("/models")),
			).toHaveLength(1);
			expect(event.response.status).toBe(429);
		} finally {
			fetched.restore();
		}
	});

	test("a refusal another account would repeat is not retried", async () => {
		const { registry } = await offered();
		const fetched = stubFetch(answer);
		try {
			// 400 is the conversation's problem, not the account's: sending it to
			// another provider would only buy the same answer more slowly.
			const event = await refuse(registry, "bad-request", 400);

			expect(
				fetched.calls.filter((request) => !request.url.endsWith("/models")),
			).toHaveLength(0);
			expect(event.response.status).toBe(400);
		} finally {
			fetched.restore();
		}
	});

	test("a retry that finds nothing leaves the row where it was", async () => {
		const { db, registry } = await offered();
		const fetched = stubFetch(() => {
			throw new Error("connection reset");
		});
		try {
			// `p2` cannot be reached either, so the walk ends with no answer at
			// all. The session is about to read `p1`'s refusal, and the next
			// request must still be pointed at `p1` rather than at the target the
			// walk merely tried.
			const event = await refuse(registry, "unreachable", 429);
			expect(event.response.status).toBe(429);

			// The refusal is what parked `p1`: a transport failure on the retry
			// says nothing about either credential. `p2` is not parked, because a
			// connection that could not be made is not an answer about an account
			// — parking it on one dropped connection emptied the row.
			expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeDefined();
			expect(getAccount(db, "p2", "a")?.rateLimitedUntil).toBeUndefined();

			// `p2` is not parked but it was already tried in this trail, so the
			// next request still goes back to `p1` — the credential that is
			// actually serving the row — rather than to the one that vanished.
			const next = call("unreachable");
			await registry["http.request"](next);
			expect(next.request.headers.get("authorization")).toBe("Bearer sk-1");
		} finally {
			fetched.restore();
		}
	});
});

describe("a request is always sent to the target's own host", () => {
	// The store recorded this exact failure: SayGM's key delivered to
	// `amr-link.open-design.ai`, which answered `[code=invalid_api_key] api key
	// not found` and the refusal was charged to SayGM. A request that names
	// neither the stub nor the base it was last sent to must still be moved.
	test("a request naming another connector is moved, path intact", () => {
		expect(
			ontoTarget({
				baseURL: "https://api.saygm.com/v1",
				replaceBase: "https://opencode.ai/inference/openai/v1",
				url: "https://amr-link.open-design.ai/v1/chat/completions",
			}),
		).toBe("https://api.saygm.com/v1/chat/completions");
	});

	test("a version path is not doubled", () => {
		expect(
			ontoTarget({
				baseURL: "https://api.saygm.com/v1",
				url: "https://api.saygm.com/v1/chat/completions?x=1",
			}),
		).toBe("https://api.saygm.com/v1/chat/completions?x=1");
	});

	test("the base it was last sent to decides the path", () => {
		expect(
			ontoTarget({
				baseURL: "https://api.cline.bot/api/v1",
				replaceBase: "https://api.saygm.com/v1",
				url: "https://api.saygm.com/v1/chat/completions",
			}),
		).toBe("https://api.cline.bot/api/v1/chat/completions");
	});

	test("a base the request does not name is never guessed from", () => {
		// The live shape: a walk whose binding had moved sent this request to
		// SayGM's host while it still carried Cline's path, and `/api/v1` came
		// along with it. The endpoint is what follows the version segment.
		expect(
			ontoTarget({
				baseURL: "https://api.saygm.com/v1",
				url: "https://api.cline.bot/api/v1/chat/completions",
			}),
		).toBe("https://api.saygm.com/v1/chat/completions");
	});

	test("a version path the connector already carries is not doubled", () => {
		// This is the shape that 404'd the live session: the stub's `/v1` plus
		// opencode's own `/inference/openai/v1` produced `/v1/v1/...`.
		expect(
			ontoTarget({
				baseURL: "https://opencode.ai/inference/openai/v1",
				url: "https://balancer.invalid/v1/chat/completions",
			}),
		).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
		expect(
			ontoTarget({
				baseURL: "https://api.saygm.com/v1",
				url: "https://balancer.invalid/v1/chat/completions",
			}),
		).toBe("https://api.saygm.com/v1/chat/completions");
	});
});
