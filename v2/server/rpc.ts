import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	getActiveAccount,
	listAccounts,
	removeAccount,
	renameAccount,
	saveAccount,
	setActiveAccount,
	setSelectedModel,
} from "../core/accounts";
import {
	getBalancingEnabled,
	listProviderPriority,
	moveProvider,
	setBalancingEnabled,
	setProviderEnabled,
	setProviderModel,
} from "../core/priority";
import { now } from "../core/time";
import { Balancer } from "../rpc";
import { readActiveCredential } from "./credentials";

type Pair = { providerID: string; alias: string };

/**
 * Typed RPC surface so clients (a GUI part, the TUI, or any SDK client) can
 * manage accounts without parsing command output.
 */
export async function registerBalancerRpc({
	ctx,
	db,
}: {
	ctx: Context;
	db: Database;
}) {
	await ctx.rpc.register(Balancer, {
		add: async (input) => {
			const { providerID, alias } = input as Pair;
			try {
				const auth = await readActiveCredential(ctx, providerID);
				if (!auth) {
					return {
						message: `No usable active credential for ${providerID}.`,
						ok: false,
					};
				}
				const account = saveAccount(db, providerID, alias, auth);
				return {
					message: `Saved ${account.providerID}/${account.alias}.`,
					ok: true,
				};
			} catch (error) {
				return {
					message: error instanceof Error ? error.message : "Save failed.",
					ok: false,
				};
			}
		},

		list: async (input) => {
			const { providerID } = (input ?? {}) as { providerID?: string };
			const accounts = providerID
				? listAccounts(db, providerID)
				: listAccounts(db);
			return {
				accounts: accounts.map((account) => ({
					active:
						getActiveAccount(db, account.providerID)?.alias === account.alias,
					alias: account.alias,
					disabled: account.disabled,
					failures: account.failures,
					limited: Boolean(
						account.rateLimitedUntil && account.rateLimitedUntil > now(),
					),
					providerID: account.providerID,
				})),
			};
		},

		move: async (input) => {
			const { providerID, direction } = input as {
				providerID: string;
				direction: "up" | "down";
			};
			moveProvider(db, providerID, direction === "up" ? -1 : 1);
			return { message: `Moved ${providerID} ${direction}.`, ok: true };
		},

		priority: async () => ({
			entries: listProviderPriority(db).map((entry) => ({
				position: entry.position,
				providerID: entry.providerID,
				...(entry.modelID ? { modelID: entry.modelID } : {}),
				enabled: entry.enabled,
			})),
		}),

		remove: async (input) => {
			const { providerID, alias } = input as Pair;
			const removed = removeAccount(db, providerID, alias);
			return {
				message: removed
					? `Removed ${providerID}/${alias}.`
					: `No account ${providerID}/${alias}.`,
				ok: removed,
			};
		},

		rename: async (input) => {
			const { providerID, alias, nextAlias } = input as Pair & {
				nextAlias: string;
			};
			try {
				const account = renameAccount(db, providerID, alias, nextAlias);
				return {
					message: `Renamed to ${providerID}/${account.alias}.`,
					ok: true,
				};
			} catch (error) {
				return {
					message: error instanceof Error ? error.message : "Rename failed.",
					ok: false,
				};
			}
		},

		setBalancing: async (input) => {
			const { enabled } = input as { enabled: boolean };
			setBalancingEnabled(db, enabled);
			return {
				message: `Automatic balancing ${enabled ? "enabled" : "disabled"}.`,
				ok: true,
			};
		},

		setEnabled: async (input) => {
			const { providerID, enabled } = input as {
				providerID: string;
				enabled: boolean;
			};
			setProviderEnabled(db, providerID, enabled);
			return {
				message: `${providerID} ${enabled ? "enabled" : "disabled"}.`,
				ok: true,
			};
		},

		setModel: async (input) => {
			const { providerID, modelID } = input as {
				providerID: string;
				modelID: string;
			};
			setProviderModel(db, providerID, modelID);
			setSelectedModel(db, providerID, modelID);
			return { message: `${providerID} uses ${modelID}.`, ok: true };
		},
		status: async () => {
			const accounts = listAccounts(db);
			return {
				accounts: accounts.length,
				balancing: getBalancingEnabled(db),
				limited: accounts.filter(
					(account) =>
						account.rateLimitedUntil && account.rateLimitedUntil > now(),
				).length,
				providers: new Set(accounts.map((account) => account.providerID)).size,
			};
		},

		use: async (input) => {
			const { providerID, alias } = input as Pair;
			try {
				const account = setActiveAccount(db, providerID, alias);
				return {
					message: `Active account is ${providerID}/${account.alias}.`,
					ok: true,
				};
			} catch (error) {
				return {
					message: error instanceof Error ? error.message : "Not found.",
					ok: false,
				};
			}
		},
	});
}
