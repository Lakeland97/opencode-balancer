import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
	getAccount,
	getActiveAccount,
	listAccounts,
	markAccountUsed,
	saveAccount,
	setActiveAccount,
} from "../core/accounts";
import { getStoredChain } from "../core/chains";
import { getBalancingEnabled, setBalancingEnabled } from "../core/priority";
import { migrate } from "../core/schema";
import { now } from "../core/time";
import { applyAuthToHeaders } from "../server/apply-auth";
import { runCommand } from "../server/commands";
import { invalidateCatalog } from "../server/connectors";
import { markRateLimited } from "../server/request-state";
import { noteServed, resetRouteMemory } from "../server/route-memory";
import {
	hasAlternativeAccount,
	selectHealthyAccount,
} from "../server/selection";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

const apiAuth = (key: string) => ({ key, type: "api" as const });

beforeEach(() => {
	invalidateCatalog();
	resetRouteMemory();
});

describe("account store", () => {
	test("migrate creates the schema and stores accounts", () => {
		const db = freshDb();
		saveAccount(db, "anthropic", "Work", apiAuth("sk-work"));
		expect(listAccounts(db)).toHaveLength(1);
		expect(getAccount(db, "anthropic", "work")?.auth).toEqual(
			apiAuth("sk-work"),
		);
	});

	test("normalizes aliases", () => {
		const db = freshDb();
		saveAccount(db, "anthropic", "  Personal Account  ", apiAuth("sk-p"));
		expect(getAccount(db, "anthropic", "personal-account")).toBeDefined();
	});
});

describe("account selection", () => {
	test("prefers the active account while it is healthy", () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		saveAccount(db, "openai", "b", apiAuth("k2"));
		setActiveAccount(db, "openai", "a");
		expect(selectHealthyAccount(db, "openai")?.alias).toBe("a");
	});

	test("skips an account parked by a rate limit", () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		saveAccount(db, "openai", "b", apiAuth("k2"));
		setActiveAccount(db, "openai", "a");
		markRateLimited(db, "openai", "a");
		expect(selectHealthyAccount(db, "openai")?.alias).toBe("b");
	});

	test("ignores disabled accounts", () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		db.query("UPDATE accounts SET disabled = 1 WHERE provider_id = ?").run(
			"openai",
		);
		expect(selectHealthyAccount(db, "openai")).toBeUndefined();
	});

	test("reports whether an alternative account exists", () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		expect(hasAlternativeAccount(db, "openai", "a")).toBe(false);
		saveAccount(db, "openai", "b", apiAuth("k2"));
		expect(hasAlternativeAccount(db, "openai", "a")).toBe(true);
	});
});

describe("rate limiting", () => {
	test("parks an account and is idempotent for the same failure", () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		markRateLimited(db, "openai", "a", 60_000);
		const first = getAccount(db, "openai", "a");
		expect(first?.failures).toBe(1);
		expect(first?.rateLimitedUntil).toBeGreaterThan(now());

		markRateLimited(db, "openai", "a", 60_000);
		const second = getAccount(db, "openai", "a");
		expect(second?.failures).toBe(1);
		expect(second?.rateLimitedUntil).toBe(first?.rateLimitedUntil);
	});
});

describe("credential injection", () => {
	test("replaces a bearer token for API-key accounts", () => {
		const headers = new Headers({ authorization: "Bearer native" });
		applyAuthToHeaders(headers, apiAuth("sk-saved"));
		expect(headers.get("authorization")).toBe("Bearer sk-saved");
	});

	test("writes a bare key when no auth header is present", () => {
		const headers = new Headers();
		applyAuthToHeaders(headers, apiAuth("sk-saved"));
		expect(headers.get("authorization")).toBe("Bearer sk-saved");
	});

	test("keeps opencode's OAuth token on the first attempt", () => {
		const headers = new Headers({ authorization: "Bearer native" });
		applyAuthToHeaders(
			headers,
			{ access: "a", expires: 1, refresh: "r", type: "oauth" },
			{ preserveExistingOAuth: true },
		);
		expect(headers.get("authorization")).toBe("Bearer native");
	});

	test("forces the saved OAuth token during failover", () => {
		const headers = new Headers({ authorization: "Bearer native" });
		applyAuthToHeaders(headers, {
			access: "saved",
			expires: 1,
			refresh: "r",
			type: "oauth",
		});
		expect(headers.get("authorization")).toBe("Bearer saved");
	});
});

describe("commands", () => {
	test("list and status describe stored state", async () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		setBalancingEnabled(db, true);

		const list = await runCommand({ ctx: {} as never, db, raw: "list" });
		expect(list).toContain("openai/a");
		expect(list).toContain("active");

		const status = await runCommand({ ctx: {} as never, db, raw: "status" });
		expect(status).toContain("Automatic balancing: on");
		expect(status).toContain("Accounts: 1");
	});

	test("toggles balancing", async () => {
		const db = freshDb();
		expect(getBalancingEnabled(db)).toBe(false);
		await runCommand({ ctx: {} as never, db, raw: "on" });
		expect(getBalancingEnabled(db)).toBe(true);
		await runCommand({ ctx: {} as never, db, raw: "off" });
		expect(getBalancingEnabled(db)).toBe(false);
	});

	test("use switches the active account", async () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		saveAccount(db, "openai", "b", apiAuth("k2"));
		const reply = await runCommand({
			ctx: {} as never,
			db,
			raw: "use openai b",
		});
		expect(reply).toContain("openai/b");
		expect(getActiveAccount(db, "openai")?.alias).toBe("b");
	});

	test("bare command reports state instead of help", async () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		const reply = await runCommand({ ctx: {} as never, db, raw: "" });
		expect(reply).toContain("Automatic balancing");
		expect(reply).toContain("openai/a");
		expect(reply).not.toContain("Balancer commands");
	});

	test("unknown commands point at help", async () => {
		const db = freshDb();
		const reply = await runCommand({ ctx: {} as never, db, raw: "nonsense" });
		expect(reply).toContain("Unknown command");
	});

	test("gui asks the desktop window to reveal the panel", async () => {
		const db = freshDb();
		let opened = 0;
		const reply = await runCommand({
			ctx: {} as never,
			db,
			openGui: async () => {
				opened += 1;
			},
			raw: "gui",
		});
		expect(opened).toBe(1);
		expect(reply).toContain("Balancer panel");
	});
});

const PACKAGE = "@opencode/ai/providers/openai-compatible";

function connectorModel(providerID: string, modelID: string, name = modelID) {
	return {
		enabled: true,
		limit: { context: 200_000, output: 4096 },
		modelID,
		name,
		package: PACKAGE,
		providerID,
		settings: { baseURL: `https://${providerID}.invalid/v1` },
		type: "chat",
	};
}

function commandCtx(data: unknown[]) {
	return { model: { list: async () => ({ data }) } } as never;
}

describe("chain commands", () => {
	test("chain lists targets in order with markers", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		saveAccount(db, "p2", "a", apiAuth("k2"));
		const ctx = commandCtx([
			connectorModel("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
			connectorModel("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
		]);
		markAccountUsed(db, "p1", "a");
		noteServed("deepseek-v4.1-flash", {
			modelID: "deepseek-v4.1-flash",
			providerID: "p1",
		});

		const reply = await runCommand({
			ctx,
			db,
			raw: "chain deepseek-v4.1-flash",
		});

		expect(reply).toContain("1. p1");
		expect(reply).toContain("2. p2");
		expect(reply).toContain("[in use]");
	});

	test("chain add appends a foreign model and refuses a duplicate provider", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		saveAccount(db, "p2", "a", apiAuth("k2"));
		const ctx = commandCtx([
			connectorModel("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
			connectorModel("p2", "mimo-v2.6-flash", "MiMo V2.6 Flash"),
		]);

		const added = await runCommand({
			ctx,
			db,
			raw: "chain deepseek-v4.1-flash add p2 mimo-v2.6-flash",
		});
		expect(added).toContain("p2");

		const duplicate = await runCommand({
			ctx,
			db,
			raw: "chain deepseek-v4.1-flash add p2 mimo-v2.6-flash",
		});
		expect(duplicate.toLowerCase()).toContain("already");
	});

	test("chain remove drops one target and refuses the last", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		saveAccount(db, "p2", "a", apiAuth("k2"));
		const ctx = commandCtx([
			connectorModel("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
			connectorModel("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
		]);

		await runCommand({
			ctx,
			db,
			raw: "chain deepseek-v4.1-flash remove p1",
		});
		expect(getStoredChain(db, "deepseek-v4.1-flash")?.targets).toHaveLength(1);

		const refused = await runCommand({
			ctx,
			db,
			raw: "chain deepseek-v4.1-flash remove p2",
		});
		expect(refused.toLowerCase()).toContain("last");
	});

	test("chain up moves a target and snapshots the automatic chain", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		saveAccount(db, "p2", "a", apiAuth("k2"));
		const ctx = commandCtx([
			connectorModel("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
			connectorModel("p2", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
		]);

		await runCommand({ ctx, db, raw: "chain deepseek-v4.1-flash up p2" });

		expect(
			getStoredChain(db, "deepseek-v4.1-flash")?.targets.map(
				(target) => target.providerID,
			),
		).toEqual(["p2", "p1"]);
	});

	test("chain reset deletes the stored chain", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		const ctx = commandCtx([
			connectorModel("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
		]);

		await runCommand({ ctx, db, raw: "chain deepseek-v4.1-flash add p1 x" });
		const reply = await runCommand({
			ctx,
			db,
			raw: "chain deepseek-v4.1-flash reset",
		});
		expect(reply.toLowerCase()).toContain("automatic");
		expect(getStoredChain(db, "deepseek-v4.1-flash")).toBeUndefined();
	});

	test("free toggles a provider's free-only rule", async () => {
		const db = freshDb();
		saveAccount(db, "p1", "a", apiAuth("k1"));
		const ctx = commandCtx([
			connectorModel("p1", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
		]);

		expect(await runCommand({ ctx, db, raw: "free p1 on" })).toContain(
			"free models only",
		);
		expect(await runCommand({ ctx, db, raw: "priority" })).toContain(
			"free-only",
		);

		expect(await runCommand({ ctx, db, raw: "free p1 off" })).toContain(
			"paid models too",
		);
		expect(await runCommand({ ctx, db, raw: "priority" })).not.toContain(
			"free-only",
		);

		expect(await runCommand({ ctx, db, raw: "free p1" })).toContain("Usage:");
	});

	test("the model and equivalents commands are gone", async () => {
		const db = freshDb();
		const ctx = commandCtx([]);
		expect(await runCommand({ ctx, db, raw: "model openai gpt-5" })).toContain(
			"Unknown command: model",
		);
		expect(await runCommand({ ctx, db, raw: "equivalents" })).toContain(
			"Unknown command: equivalents",
		);
	});
});
