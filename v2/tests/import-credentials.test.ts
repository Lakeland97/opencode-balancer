import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";

import { getAccount, getActiveAccount, listAccounts } from "../core/accounts";
import { migrate } from "../core/schema";
import { syncAccounts } from "../server/import-credentials";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

type Connection = {
	type: string;
	id?: string;
	label?: string;
	method?: string;
	name?: string;
};

type Options = {
	integrations?: readonly { id: string; connections?: readonly Connection[] }[];
	resolved?: Record<string, unknown>;
	failing?: readonly string[];
	active?: Record<string, Connection>;
	listFails?: boolean;
};

function fakeContext(options: Options) {
	return {
		integration: {
			connection: {
				active: async (integrationID: string) =>
					options.active?.[integrationID],
				resolve: async (connection: Connection) => {
					if (connection.id && options.failing?.includes(connection.id))
						throw new Error("resolve failed");
					return options.resolved?.[connection.id ?? ""];
				},
			},
			list: async () => {
				if (options.listFails) throw new Error("list failed");
				return { data: options.integrations ?? [] };
			},
		},
	} as unknown as Context;
}

const key = (value: string) => ({ key: value, type: "api" as const });

// Every sync in this file reads a config dir of its own, so the machine's real
// providers never leak into the assertions.
let configHome = "";
beforeEach(() => {
	configHome = mkdtempSync(join(tmpdir(), "balancer-config-"));
	process.env.OPENCODE_CONFIG_DIR = configHome;
});
afterEach(() => {
	delete process.env.OPENCODE_CONFIG_DIR;
	rmSync(configHome, { force: true, recursive: true });
});

describe("importing OpenCode's credentials", () => {
	test("two credentials on one provider are both imported", async () => {
		const db = freshDb();
		const ctx = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
						{
							id: "cred_2",
							label: "ByteBuilt",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: {
				cred_1: { key: "sk-personal", type: "key" },
				cred_2: { key: "sk-bytebuilt", type: "key" },
			},
		});

		const result = await syncAccounts(ctx, db);

		expect(result.imported).toBe(2);
		expect(
			listAccounts(db, "opencode-go").map((account) => account.alias),
		).toEqual(["bytebuilt", "personal"]);
	});

	test("the same credential on a second sync is not duplicated", async () => {
		const db = freshDb();
		const ctx = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: { cred_1: { key: "sk-personal", type: "key" } },
		});

		await syncAccounts(ctx, db);
		await syncAccounts(ctx, db);

		expect(listAccounts(db, "opencode-go")).toHaveLength(1);
	});

	test("an environment connection is not an account", async () => {
		const db = freshDb();
		const ctx = fakeContext({
			integrations: [
				{
					connections: [{ name: "OPENAI_API_KEY", type: "env" }],
					id: "openai",
				},
			],
		});

		const result = await syncAccounts(ctx, db);

		expect(result.imported).toBe(0);
		expect(listAccounts(db, "openai")).toHaveLength(0);
	});

	test("the credential OpenCode calls active becomes the provider's default", async () => {
		const db = freshDb();
		const ctx = fakeContext({
			active: {
				"opencode-go": { id: "cred_2", label: "ByteBuilt", type: "credential" },
			},
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
						{
							id: "cred_2",
							label: "ByteBuilt",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: {
				cred_1: { key: "sk-personal", type: "key" },
				cred_2: { key: "sk-bytebuilt", type: "key" },
			},
		});

		await syncAccounts(ctx, db);

		expect(getActiveAccount(db, "opencode-go")?.alias).toBe("bytebuilt");
	});

	test("a credential OpenCode no longer lists is removed", async () => {
		const db = freshDb();
		const first = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
						{
							id: "cred_2",
							label: "ByteBuilt",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: {
				cred_1: { key: "sk-personal", type: "key" },
				cred_2: { key: "sk-bytebuilt", type: "key" },
			},
		});
		await syncAccounts(first, db);

		const second = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_2",
							label: "ByteBuilt",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: { cred_2: { key: "sk-bytebuilt", type: "key" } },
		});
		const result = await syncAccounts(second, db);

		expect(result.pruned).toBe(1);
		expect(
			listAccounts(db, "opencode-go").map((account) => account.alias),
		).toEqual(["bytebuilt"]);
	});

	test("a credential that cannot be resolved keeps its last copy", async () => {
		const db = freshDb();
		const first = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: { cred_1: { key: "sk-personal", type: "key" } },
		});
		await syncAccounts(first, db);

		const failing = fakeContext({
			failing: ["cred_1"],
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
		});
		const result = await syncAccounts(failing, db);

		expect(result.pruned).toBe(0);
		expect(listAccounts(db, "opencode-go")).toHaveLength(1);
	});

	test("a credential the balancer cannot reuse keeps its last copy", async () => {
		const db = freshDb();
		const first = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: { cred_1: { key: "sk-personal", type: "key" } },
		});
		await syncAccounts(first, db);

		// External credentials hand over no reusable secret; they are listed but
		// not importable, and must not erase what is already stored.
		const external = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "external",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: { cred_1: { type: "external" } },
		});
		const result = await syncAccounts(external, db);

		expect(result.pruned).toBe(0);
		expect(listAccounts(db, "opencode-go")).toHaveLength(1);
	});

	test("a sync that cannot read OpenCode leaves the accounts alone", async () => {
		const db = freshDb();
		const first = fakeContext({
			integrations: [
				{
					connections: [
						{
							id: "cred_1",
							label: "Personal",
							method: "key",
							type: "credential",
						},
					],
					id: "opencode-go",
				},
			],
			resolved: { cred_1: { key: "sk-personal", type: "key" } },
		});
		await syncAccounts(first, db);

		const broken = fakeContext({ listFails: true });
		const result = await syncAccounts(broken, db);

		expect(result).toEqual({ imported: 0, pruned: 0 });
		expect(listAccounts(db, "opencode-go")).toHaveLength(1);
	});

	test("an entry added by hand is pruned, because the host is the source", async () => {
		const db = freshDb();
		const { saveAccount } = await import("../core/accounts");
		saveAccount(db, "acme", "main", key("sk-hand"));

		const ctx = fakeContext({ integrations: [] });
		const result = await syncAccounts(ctx, db);

		expect(result.pruned).toBe(1);
		expect(listAccounts(db, "acme")).toHaveLength(0);
	});
});

describe("providers configured with their own key", () => {
	test("the key beside the provider name becomes an account, and leaves with it", async () => {
		writeFileSync(
			join(configHome, "opencode.json"),
			JSON.stringify({
				providers: {
					"open-design": {
						env: ["OPENDESIGN_API_KEY", "sk-live-abcdefghijklmnop"],
						name: "Open-Design",
						settings: { baseURL: "https://open-design.invalid/v1" },
					},
				},
			}),
		);
		const db = freshDb();
		const ctx = fakeContext({ integrations: [] });

		const result = await syncAccounts(ctx, db);

		expect(result.imported).toBe(1);
		expect(getAccount(db, "open-design", "open-design")?.auth).toEqual(
			key("sk-live-abcdefghijklmnop"),
		);
		expect(listAccounts(db, "open-design")).toHaveLength(1);

		// The synthetic source survives a second sync instead of being pruned
		// as a hand-added account.
		await syncAccounts(ctx, db);
		expect(listAccounts(db, "open-design")).toHaveLength(1);

		// Taking the provider out of the config is how it leaves the balancer.
		writeFileSync(
			join(configHome, "opencode.json"),
			JSON.stringify({ providers: {} }),
		);
		const removed = await syncAccounts(ctx, db);
		expect(removed.pruned).toBe(1);
		expect(listAccounts(db, "open-design")).toHaveLength(0);
	});
});
