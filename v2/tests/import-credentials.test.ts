import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";

import { getActiveAccount, listAccounts } from "../core/accounts";
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
