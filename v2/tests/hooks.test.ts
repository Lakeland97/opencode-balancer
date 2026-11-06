import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Context } from "@opencode/plugin";

import { getAccount, saveAccount, setActiveAccount } from "../core/accounts";
import { setBalancingEnabled } from "../core/priority";
import { migrate } from "../core/schema";
import { now } from "../core/time";
import { registerHooks } from "../server/hooks";
import { markRateLimited } from "../server/request-state";

const PROVIDER = "anthropic";
const MODEL = { providerID: PROVIDER, id: "claude-test" };

type HookCallback = (event: Record<string, unknown>) => unknown;

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

const apiAuth = (key: string) => ({ type: "api" as const, key });

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
		sessionID,
		agent: "build",
		model: MODEL,
		kind: "chat",
		request,
	};
}

function newRequest() {
	return new Request("https://api.example.test/v1/messages", {
		method: "POST",
		headers: { authorization: "Bearer native" },
	});
}

function retryEvent(sessionID: string, decision: Record<string, unknown>) {
	return {
		sessionID,
		agent: "build",
		model: MODEL,
		error: { status: 429 },
		attempt: 1,
		decision,
	};
}

describe("http.request hook", () => {
	test("injects the active account's api key into the authorization header", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));

		const event = requestEvent("request-active", newRequest());
		await registry["http.request"](event);

		expect(event.request.headers.get("authorization")).toBe("Bearer sk-primary");
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

		const event = retryEvent("retry-failover", { retry: false, delay: 1_500 });
		await registry.retry(event);

		expect(event.decision).toEqual({ retry: true, delay: 0 });
	});

	test("leaves the decision unchanged when no alternative account exists", async () => {
		const { db, registry } = await setup();
		saveAccount(db, PROVIDER, "primary", apiAuth("sk-primary"));
		setBalancingEnabled(db, true);

		await registry["http.request"](
			requestEvent("retry-no-alternative", newRequest()),
		);

		const decision = { retry: false, delay: 2_500 };
		const event = retryEvent("retry-no-alternative", decision);
		await registry.retry(event);

		expect(event.decision).toEqual({ retry: false, delay: 2_500 });
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

		const decision = { retry: false, delay: 3_000 };
		const event = retryEvent("retry-balancing-off", decision);
		await registry.retry(event);

		expect(event.decision).toEqual({ retry: false, delay: 3_000 });
	});
});
