import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	getAccount,
	getActiveAccount,
	listAccounts,
	saveAccount,
	setActiveAccount,
} from "../core/accounts";
import {
	getBalancingEnabled,
	listProviderPriority,
	setBalancingEnabled,
} from "../core/priority";
import { migrate } from "../core/schema";
import { now } from "../core/time";
import { applyAuthToHeaders } from "../server/apply-auth";
import { runCommand } from "../server/commands";
import { markRateLimited } from "../server/request-state";
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

	test("model sets priority and selected model", async () => {
		const db = freshDb();
		saveAccount(db, "openai", "a", apiAuth("k1"));
		await runCommand({
			ctx: {} as never,
			db,
			raw: "model openai gpt-5",
		});
		const entry = listProviderPriority(db).find(
			(row) => row.providerID === "openai",
		);
		expect(entry?.modelID).toBe("gpt-5");
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
});
