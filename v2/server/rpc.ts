import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	getActiveAccount,
	listAccounts,
	mostRecentlyUsed,
	removeAccount,
	renameAccount,
	saveAccount,
	setActiveAccount,
} from "../core/accounts";
import { type CompactionBuffer, declaredContext } from "../core/context";
import {
	getBalancingEnabled,
	isFreeOnly,
	listProviderPriority,
	moveProvider,
	setBalancingEnabled,
	setFreeOnly,
	setProviderEnabled,
} from "../core/priority";
import { now } from "../core/time";
import { Balancer } from "../rpc";
import {
	addTarget,
	createChain,
	removeTarget,
	resetRow,
	rowByKey,
	shiftTarget,
} from "./chain-actions";
import {
	compactionConfigPath,
	readBufferAt,
	readCompactionBuffer,
	writeCompactionBuffer,
} from "./compaction-config";
import {
	type FamilyRoute,
	invalidateCatalog,
	loadCatalog,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import { readActiveCredential } from "./credentials";
import { chooseRoute, isProviderEnabled } from "./routing";
import { selectHealthyAccount } from "./selection";

type Pair = { providerID: string; alias: string };

/**
 * The model a target will actually be sent to. A free-only provider is handed
 * its own free spelling of the model, which the row should show rather than the
 * paid id it was configured with.
 */
function resolvedModelID(db: Database, target: FamilyRoute): string {
	if (target.free !== false || !isFreeOnly(db, target.providerID)) {
		return target.modelID;
	}
	return target.freeVariant?.modelID ?? target.modelID;
}

function targetState(
	db: Database,
	family: ModelFamily,
	target: { providerID: string; modelID: string; available?: boolean },
): string {
	const live = chooseRoute(db, family);
	const serving =
		live?.providerID === target.providerID && live.modelID === target.modelID;
	if (target.available === false) return "unavailable";
	if (!isProviderEnabled(db, target.providerID)) return "disabled";
	const account = selectHealthyAccount(db, target.providerID);
	if (!account) return "unavailable";
	if (account.rateLimitedUntil && account.rateLimitedUntil > now()) {
		return "limited";
	}
	// A row's targets are labelled by what would serve next, not by what is
	// serving: only one account is genuinely in use at a time.
	return serving ? "next" : "available";
}

/**
 * Typed RPC surface so clients (a GUI part, the TUI, or any SDK client) can
 * manage accounts without parsing command output.
 */
/** A buffer as the panel shows it: `75%`, `150000`, or blank for none. */
function bufferText(buffer: CompactionBuffer): string {
	if (buffer.kind === "percent")
		return `${Number((buffer.percent * 100).toFixed(2))}%`;
	if (buffer.kind === "tokens") return String(buffer.tokens);
	return "";
}

export async function registerBalancerRpc({
	ctx,
	db,
	buffer = readCompactionBuffer(),
	configPath = compactionConfigPath(),
	refresh,
}: {
	ctx: Context;
	db: Database;
	buffer?: CompactionBuffer;
	/** The file a buffer change is written to. Defaults to the effective one. */
	configPath?: string;
	/** Re-reads models so a changed buffer reaches the host's declared limits. */
	refresh?: () => Promise<void> | void;
}) {
	const registration = await ctx.rpc.register(Balancer, {
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
				invalidateCatalog();
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

		buffer: async () => ({
			path: configPath ?? "",
			value: bufferText(configPath ? readBufferAt(configPath) : buffer),
		}),

		chainAdd: async (input) => {
			const { key, providerID, modelID } = input as {
				key: string;
				providerID: string;
				modelID: string;
			};
			const family = await rowByKey(ctx, db, key);
			if (!family) return { message: `No row named ${key}.`, ok: false };
			const result = await addTarget(ctx, db, family, providerID, modelID);
			return result;
		},

		chainCreate: async (input) => {
			const { providerID, modelID } = input as {
				providerID: string;
				modelID: string;
			};
			return createChain(ctx, db, providerID, modelID);
		},

		chainModels: async (input) => {
			const { providerID } = input as { providerID: string };
			const list = await ctx.model.list();
			return {
				models: list.data
					.filter(
						(model) =>
							model.providerID === providerID &&
							(!model.type || model.type === "chat") &&
							model.enabled !== false &&
							typeof model.settings?.baseURL === "string",
					)
					.map((model) => ({
						modelID: model.modelID,
						name: model.name ?? model.modelID,
					})),
			};
		},

		chainMove: async (input) => {
			const { key, providerID, direction } = input as {
				key: string;
				providerID: string;
				direction: "up" | "down";
			};
			const family = await rowByKey(ctx, db, key);
			if (!family) return { message: `No row named ${key}.`, ok: false };
			return shiftTarget(db, family, providerID, direction);
		},

		chainRemove: async (input) => {
			const { key, providerID } = input as {
				key: string;
				providerID: string;
			};
			const family = await rowByKey(ctx, db, key);
			if (!family) return { message: `No row named ${key}.`, ok: false };
			return removeTarget(db, family, providerID);
		},

		chainReset: async (input) => {
			const { key } = input as { key: string };
			const family = await rowByKey(ctx, db, key);
			if (!family) return { message: `No row named ${key}.`, ok: false };
			const existed = resetRow(db, family);
			return {
				message: existed
					? `${key} is back to automatic order.`
					: `${key} was already automatic.`,
				ok: true,
			};
		},

		chains: async () => {
			const catalog = await loadCatalog(ctx, db);
			return {
				rows: catalog.families.map((family) => {
					const window = family.window;
					return {
						context: window?.context ?? 0,
						declaredContext: window
							? declaredContext(window.context, buffer, window.ceiling)
							: 0,
						key: family.key,
						label: family.name,
						package: family.package,
						stored: Boolean(family.stored),
						targets: resolveChain(db, family).map((target) => ({
							modelID: target.modelID,
							providerID: target.providerID,
							resolved: resolvedModelID(db, target),
							state: targetState(db, family, target),
						})),
					};
				}),
			};
		},

		list: async (input) => {
			const { providerID } = (input ?? {}) as { providerID?: string };
			const accounts = providerID
				? listAccounts(db, providerID)
				: listAccounts(db);
			// Exactly one account is "in use": the one that served the most
			// recent request. A limited or disabled account is never also
			// reported as the active default, which reads as a contradiction.
			const used = mostRecentlyUsed(db);
			return {
				accounts: accounts.map((account) => {
					const limited = Boolean(
						account.rateLimitedUntil && account.rateLimitedUntil > now(),
					);
					return {
						active:
							!account.disabled &&
							!limited &&
							getActiveAccount(db, account.providerID)?.alias === account.alias,
						alias: account.alias,
						disabled: account.disabled,
						failures: account.failures,
						inUse:
							!account.disabled &&
							used?.providerID === account.providerID &&
							used.alias === account.alias,
						lastUsedAt: account.lastUsedAt ?? 0,
						limited,
						providerID: account.providerID,
					};
				}),
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

		priority: async () => {
			// The panel's client cannot always reach the provider catalogue, and
			// a missing display name must not cost the whole list.
			const names = new Map<string, string>();
			try {
				const providers = await ctx.provider.list();
				for (const provider of providers.data) {
					names.set(provider.id, provider.name);
				}
			} catch {
				// Ids are the fallback.
			}
			return {
				entries: listProviderPriority(db).map((entry) => ({
					enabled: entry.enabled,
					freeOnly: entry.freeOnly,
					name: names.get(entry.providerID) ?? entry.providerID,
					position: entry.position,
					providerID: entry.providerID,
					...(entry.modelID ? { modelID: entry.modelID } : {}),
				})),
			};
		},

		remove: async (input) => {
			const { providerID, alias } = input as Pair;
			const removed = removeAccount(db, providerID, alias);
			invalidateCatalog();
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

		setBuffer: async (input) => {
			const { value } = input as { value: string };
			if (!configPath) {
				return {
					message: "No OpenCode config file to write a buffer into.",
					ok: false,
				};
			}
			try {
				writeCompactionBuffer(configPath, value);
			} catch (error) {
				return {
					message:
						error instanceof Error ? error.message : "Could not write buffer.",
					ok: false,
				};
			}
			await refresh?.();
			return {
				message: `Compaction buffer set to ${bufferText(readBufferAt(configPath))}.`,
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

		setFreeOnly: async (input) => {
			const { providerID, enabled } = input as {
				providerID: string;
				enabled: boolean;
			};
			setFreeOnly(db, providerID, enabled);
			return {
				message: `${providerID} uses ${enabled ? "free models only" : "paid models too"}.`,
				ok: true,
			};
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

	return registration;
}
