import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	ensureActiveAlias,
	getAccountBySourceID,
	importAccount,
	pruneImportedAccounts,
} from "../core/accounts";
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

			importAccount(db, {
				auth,
				label: connection.label ?? "",
				providerID: integration.id,
				sourceID: connection.id,
			});
			imported += 1;
		}
		if (sawCredential) withCredentials.push(integration.id);
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
