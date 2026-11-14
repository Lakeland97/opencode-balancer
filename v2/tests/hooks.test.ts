import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";

import {
	getAccount,
	readLimitedReason,
	saveAccount,
	setActiveAccount,
} from "../core/accounts";
import { setBalancingEnabled } from "../core/priority";
import { migrate } from "../core/schema";
import { now } from "../core/time";
import { invalidateCatalog } from "../server/connectors";
import { balancerTargetFor, registerHooks } from "../server/hooks";
import { markRateLimited } from "../server/request-state";

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
			headers: {},
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
