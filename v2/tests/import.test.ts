import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	ensureActiveAlias,
	getAccount,
	getActiveAccount,
	importAccount,
	listAccounts,
	markAccountUsed,
	pruneImportedAccounts,
	saveAccount,
	setActiveAccount,
} from "../core/accounts";
import { migrate } from "../core/schema";
import { markRateLimited } from "../server/request-state";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

const key = (value: string) => ({ key: value, type: "api" as const });

describe("importing an account from OpenCode", () => {
	test("it remembers the credential it came from", () => {
		const db = freshDb();

		importAccount(db, {
			auth: key("sk-first"),
			label: "Personal",
			providerID: "opencode-go",
			sourceID: "cred_1",
		});

		const account = getAccount(db, "opencode-go", "personal");
		expect(account?.sourceID).toBe("cred_1");
		expect(account?.auth).toEqual(key("sk-first"));
	});

	test("two credentials on one provider become two accounts", () => {
		const db = freshDb();

		importAccount(db, {
			auth: key("sk-personal"),
			label: "Personal",
			providerID: "opencode-go",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: key("sk-bytebuilt"),
			label: "ByteBuilt",
			providerID: "opencode-go",
			sourceID: "cred_2",
		});

		const accounts = listAccounts(db, "opencode-go");
		expect(accounts.map((account) => account.alias).sort()).toEqual([
			"bytebuilt",
			"personal",
		]);
	});

	test("the same label twice does not merge two credentials", () => {
		const db = freshDb();

		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: key("sk-two"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_2",
		});

		const accounts = listAccounts(db, "acme");
		expect(accounts).toHaveLength(2);
		expect(accounts.map((account) => account.sourceID).sort()).toEqual([
			"cred_1",
			"cred_2",
		]);
		expect(getAccount(db, "acme", "personal-2")?.auth).toEqual(key("sk-two"));
	});

	test("a blank label still gets a usable name", () => {
		const db = freshDb();

		importAccount(db, {
			auth: key("sk-one"),
			label: "   ",
			providerID: "acme",
			sourceID: "cred_1",
		});

		expect(listAccounts(db, "acme")).toHaveLength(1);
		expect(listAccounts(db, "acme")[0]?.alias).toBeTruthy();
	});

	test("re-importing refreshes the key and keeps the alias", () => {
		const db = freshDb();

		importAccount(db, {
			auth: key("sk-old"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: key("sk-new"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});

		expect(listAccounts(db, "acme")).toHaveLength(1);
		expect(getAccount(db, "acme", "personal")?.auth).toEqual(key("sk-new"));
	});

	test("a rename in OpenCode follows the credential, not the text", () => {
		const db = freshDb();

		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: key("sk-one"),
			label: "Work",
			providerID: "acme",
			sourceID: "cred_1",
		});

		const accounts = listAccounts(db, "acme");
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.alias).toBe("work");
	});

	test("re-importing does not undo the state the balancer tracks", () => {
		const db = freshDb();

		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});
		markRateLimited(db, "acme", "personal", 60_000, "HTTP 429");
		markAccountUsed(db, "acme", "personal", 1_000);

		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});

		const account = getAccount(db, "acme", "personal");
		expect(account?.lastUsedAt).toBe(1_000);
	});
});

describe("pruning the accounts OpenCode no longer has", () => {
	test("a credential that is gone is removed", () => {
		const db = freshDb();
		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: key("sk-two"),
			label: "Work",
			providerID: "acme",
			sourceID: "cred_2",
		});

		const pruned = pruneImportedAccounts(db, ["cred_2"]);

		expect(pruned).toBe(1);
		expect(listAccounts(db, "acme").map((account) => account.alias)).toEqual([
			"work",
		]);
	});

	test("an entry added by hand is removed, because the host is the source", () => {
		const db = freshDb();
		saveAccount(db, "acme", "main", key("sk-hand"));

		const pruned = pruneImportedAccounts(db, []);

		expect(pruned).toBe(1);
		expect(listAccounts(db, "acme")).toHaveLength(0);
	});

	test("nothing is pruned when the sync could not read the host", () => {
		const db = freshDb();
		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});

		expect(pruneImportedAccounts(db, ["cred_1"])).toBe(0);
		expect(listAccounts(db, "acme")).toHaveLength(1);
	});
});

describe("the default account after a sync", () => {
	test("the host's active credential becomes the default when the old one is gone", () => {
		const db = freshDb();
		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: key("sk-two"),
			label: "ByteBuilt",
			providerID: "acme",
			sourceID: "cred_2",
		});
		// A selection pointing at an account that no longer exists, as happens
		// when a hand-added entry is pruned and re-imported under its label.
		db.query(
			"INSERT INTO provider_state (provider_id, active_alias, updated_at, metadata_json) VALUES ('acme', 'personal-2', ?, '{}') ON CONFLICT(provider_id) DO UPDATE SET active_alias = 'personal-2'",
		).run(Date.now());

		ensureActiveAlias(db, "acme", "bytebuilt");

		expect(getActiveAccount(db, "acme")?.alias).toBe("bytebuilt");
	});

	test("a live selection is left alone", () => {
		const db = freshDb();
		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});
		importAccount(db, {
			auth: key("sk-two"),
			label: "ByteBuilt",
			providerID: "acme",
			sourceID: "cred_2",
		});
		setActiveAccount(db, "acme", "personal");

		ensureActiveAlias(db, "acme", "bytebuilt");

		expect(getActiveAccount(db, "acme")?.alias).toBe("personal");
	});

	test("a provider with no selection takes the host's active one", () => {
		const db = freshDb();
		importAccount(db, {
			auth: key("sk-one"),
			label: "Personal",
			providerID: "acme",
			sourceID: "cred_1",
		});

		ensureActiveAlias(db, "acme", "personal");

		expect(getActiveAccount(db, "acme")?.alias).toBe("personal");
	});
});
