import { Database } from "bun:sqlite";
import { describe, expect, setSystemTime, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";

import {
	getAccount,
	readLimitedReason,
	saveAccount,
	setActiveAccount,
} from "../core/accounts";
import { listEvents } from "../core/events";
import { setBalancingEnabled } from "../core/priority";
import { setRebalance, setRebalanceAuto } from "../core/rebalance";
import { migrate } from "../core/schema";
import { now } from "../core/time";
import { invalidateCatalog } from "../server/connectors";
import {
	balancerTargetFor,
	forgetRoutingMemory,
	registerHooks,
} from "../server/hooks";
import { markRateLimited } from "../server/request-state";
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

	test("a routed call records the row and the window it went through", async () => {
		const { registry } = await routedSetup();
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
		expect(balancerTargetFor("routed-1")).toEqual({
			context: 200_000,
			familyKey: "deepseek-v4.1-flash",
			providerID: "p1",
		});
	});

	test("a session that never routed here has nothing to compact", async () => {
		await routedSetup();
		expect(balancerTargetFor("never-routed")).toBeUndefined();
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

	test("past a quota window the order starts from the head again", async () => {
		const start = Date.now();
		const { registry } = await twoProviders();
		await failOverFromTheHead(registry, "stale-window");

		// Five hours on, the provider's window has refilled and p1's park is long
		// expired, so the trail describes a world that no longer exists.
		setSystemTime(start + FIVE_HOURS + 60_000);
		try {
			const event = request("stale-window");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-1");
		} finally {
			setSystemTime();
		}
	});

	test("inside the window the trail still decides, so a park is not the reason", async () => {
		const start = Date.now();
		const { registry } = await twoProviders();
		await failOverFromTheHead(registry, "fresh-window");

		// p1's park has expired here too, so only the trail can explain p2 being
		// chosen: the session already tried p1 and has not had an answer since.
		setSystemTime(start + FIVE_HOURS - 60_000);
		try {
			const event = request("fresh-window");
			await registry["model.request"](event);
			expect(event.headers.authorization).toBe("Bearer sk-2");
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

		// Ten hours idle: past any quota window, and past the built-in default
		// twice over. Off means nothing but a change to the order clears a trail.
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
});
