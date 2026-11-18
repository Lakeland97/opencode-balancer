import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	ensureActiveAlias,
	getAccountBySourceID,
	importAccount,
	pruneImportedAccounts,
} from "../core/accounts";
import { configDir } from "../core/path";
import { credentialToAuth } from "./credentials";
import { recordLog } from "./log";

type ConnectionInfo = {
	type?: string;
	id?: string;
	label?: string;
	method?: string;
};
type IntegrationInfo = {
	id: string;
	connections?: readonly ConnectionInfo[];
};

export type SyncResult = { imported: number; pruned: number };

type ConfiguredProvider = { id: string; key: string; label: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A provider configured in `opencode.json` carries its own key, usually as the
 * literal value beside the variable name (`env: ["NAME", "sk-..."]`). The host
 * never turns that into a credential connection, so without reading it here the
 * provider would exist in OpenCode and be invisible to the balancer forever.
 */
function literalKey(value: string): string | undefined {
	return value.length >= 16 && !ENV_NAME.test(value) ? value : undefined;
}

function keyFromEntry(entry: Record<string, unknown>): string | undefined {
	const settings = entry.settings as Record<string, unknown> | undefined;
	const options = entry.options as Record<string, unknown> | undefined;
	for (const candidate of [settings?.apiKey, options?.apiKey, entry.apiKey]) {
		if (typeof candidate === "string" && candidate.trim() !== "")
			return candidate;
	}

	const env = entry.env;
	if (Array.isArray(env)) {
		for (const value of env) {
			if (typeof value !== "string") continue;
			const literal = literalKey(value);
			if (literal) return literal;
		}
	} else if (env && typeof env === "object") {
		for (const value of Object.values(env)) {
			if (typeof value !== "string" || value.trim() === "") continue;
			return value;
		}
	}
	return undefined;
}

function readConfig(path: string): Record<string, unknown> | undefined {
	try {
		const raw = readFileSync(path, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Providers whose key lives in the config rather than in OpenCode's store. */
export function configuredProviders(): ConfiguredProvider[] {
	const providers = new Map<string, ConfiguredProvider>();
	// `opencode.json` wins when both spellings exist.
	for (const name of ["opencode.jsonc", "opencode.json"]) {
		const document = readConfig(join(configDir(), name));
		if (!document) continue;
		for (const blockName of ["provider", "providers"]) {
			const block = document[blockName];
			if (!block || typeof block !== "object") continue;
			for (const [id, raw] of Object.entries(block)) {
				if (!raw || typeof raw !== "object") continue;
				const entry = raw as Record<string, unknown>;
				if (entry.disabled === true || entry.enabled === false) continue;
				const key = keyFromEntry(entry);
				if (!key) continue;
				const label =
					typeof entry.name === "string" && entry.name.trim() !== ""
						? entry.name
						: id;
				providers.set(id, { id, key, label });
			}
		}
	}
	return [...providers.values()];
}

/**
 * Copy every credential OpenCode holds into the balancer's own accounts. The
 * host is the source of truth: a key added there shows up here on the next
 * sync, and one removed there is pruned here. Nothing is added by hand, and two
 * credentials on one provider simply become two accounts.
 *
 * A credential the host lists but cannot hand over a usable secret for keeps
 * its last copy, so a transient resolve failure never silently drops a working
 * account.
 */
export async function syncAccounts(
	ctx: Context,
	db: Database,
): Promise<SyncResult> {
	let integrations: readonly IntegrationInfo[];
	try {
		const listed = (await ctx.integration.list()) as {
			data?: readonly IntegrationInfo[];
		};
		integrations = listed?.data ?? [];
	} catch {
		// Without a readable list, pruning would delete accounts that are still
		// perfectly good. Leave everything as it is and say so.
		recordLog(
			"error",
			"could not read OpenCode's credentials; leaving the accounts as they are",
		);
		return { imported: 0, pruned: 0 };
	}

	const keep: string[] = [];
	// Only providers with a credential are worth asking the host about, and the
	// host has hundreds of integrations registered, most of them empty.
	const withCredentials: string[] = [];
	let imported = 0;

	for (const integration of integrations) {
		let sawCredential = false;
		for (const connection of integration.connections ?? []) {
			if (connection.type !== "credential" || !connection.id) continue;
			sawCredential = true;
			keep.push(connection.id);

			let value: unknown;
			try {
				value = await ctx.integration.connection.resolve(
					connection as Parameters<
						Context["integration"]["connection"]["resolve"]
					>[0],
				);
			} catch {
				continue;
			}
			const auth = credentialToAuth(value);
			if (!auth) continue;

			const existing = getAccountBySourceID(db, integration.id, connection.id);
			importAccount(db, {
				auth,
				label: connection.label ?? "",
				providerID: integration.id,
				sourceID: connection.id,
			});
			// Counting every re-import as news made each sync look like a change,
			// which rebuilt the provider on every event and refreshed forever.
			if (!existing) imported += 1;
		}
		if (sawCredential) withCredentials.push(integration.id);
	}

	// A provider can hold its key in the config without a credential connection
	// for the host to expose. Import those too, but never in addition to a real
	// credential for the same provider: that one can rotate and is authoritative.
	for (const provider of configuredProviders()) {
		if (provider.id === "balancer") continue;
		if (withCredentials.includes(provider.id)) continue;
		const sourceID = `config:${provider.id}`;
		keep.push(sourceID);
		const auth = credentialToAuth({ key: provider.key, type: "key" });
		if (!auth) continue;
		const existing = getAccountBySourceID(db, provider.id, sourceID);
		importAccount(db, {
			auth,
			label: provider.label,
			providerID: provider.id,
			sourceID,
		});
		if (!existing) imported += 1;
	}

	const pruned = pruneImportedAccounts(db, keep);

	// Where the balancer has no live choice of its own, follow the credential
	// OpenCode itself is pointed at, so the two agree out of the box.
	for (const providerID of withCredentials) {
		let active: ConnectionInfo | undefined;
		try {
			active = (await ctx.integration.connection.active(providerID)) as
				| ConnectionInfo
				| undefined;
		} catch {
			continue;
		}
		if (active?.type !== "credential" || !active.id) continue;

		const account = getAccountBySourceID(db, providerID, active.id);
		if (account) ensureActiveAlias(db, providerID, account.alias);
	}

	if (imported > 0 || pruned > 0) {
		recordLog(
			"route",
			`OpenCode sync: ${imported} credential${imported === 1 ? "" : "s"} imported${
				pruned > 0 ? `, ${pruned} removed` : ""
			}`,
		);
	}

	return { imported, pruned };
}
