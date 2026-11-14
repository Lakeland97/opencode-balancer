import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	getActiveAccount,
	listAccounts,
	mostRecentlyUsed,
	readHostActiveSource,
	readLimitedReason,
	setActiveAccount,
} from "../core/accounts";
import {
	type CompactionBuffer,
	reserveLabel,
	targetShare,
	tripContext,
} from "../core/context";
import {
	readRowLimit,
	readTargetLimit,
	setRowLimit,
	setTargetLimit,
} from "../core/limits";
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
import { clearLog, readLog, recordLog } from "./log";
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
 * A limit the panel typed. An empty field clears the limit; anything that is
 * not a whole token count is refused rather than stored as a NaN.
 */
function parseLimit(
	value: string,
): { ok: true; tokens: number | undefined } | { ok: false; message: string } {
	const trimmed = value.trim();
	if (trimmed === "") return { ok: true, tokens: undefined };
	if (!/^\d+$/.test(trimmed)) {
		return { message: `"${value}" is not a token count.`, ok: false };
	}
	return { ok: true, tokens: Number(trimmed) };
}

/**
 * Typed RPC surface so clients (a GUI part, the TUI, or any SDK client) can
 * manage accounts without parsing command output.
 */
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
			// Read the buffer at call time: the panel redraws from here the
			// moment after it writes a new value, and the captured one is stale.
			const current = configPath ? readBufferAt(configPath) : buffer;
			return {
				rows: catalog.families.map((family) => {
					const window = family.window;
					return {
						// The window the host is told the model holds, which is
						// the row's smallest target as it really is; the config's
						// reserve is what moves the trip inside it.
						context: window?.context ?? 0,
						key: family.key,
						label: family.name,
						limit: readRowLimit(db, family.key) ?? 0,
						package: family.package,
						stored: Boolean(family.stored),
						targets: resolveChain(db, family).map((target) => ({
							limit: readTargetLimit(db, family.key, target.providerID) ?? 0,
							modelID: target.modelID,
							providerID: target.providerID,
							resolved: resolvedModelID(db, target),
							state: targetState(db, family, target),
						})),
						trip: window ? tripContext(window.context, current) : 0,
					};
				}),
			};
		},

		clearLog: async () => {
			clearLog();
			return { message: "Cleared the log.", ok: true };
		},

		contextTarget: async () => {
			const current = configPath
				? readBufferAt(configPath)
				: readCompactionBuffer();
			return {
				// The share left to use and the reserve it is stored as are the
				// same fact: the panel edits this, the host applies it.
				reserve: reserveLabel(current),
				target: targetShare(current),
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
					// A park is cleared by the next attempt, so any park at all
					// reads as limited: the account failed and has not been
					// tried since.
					const limited = account.rateLimitedUntil != null;
					return {
						active:
							!account.disabled &&
							!limited &&
							getActiveAccount(db, account.providerID)?.alias === account.alias,
						alias: account.alias,
						disabled: account.disabled,
						failures: account.failures,
						// True when this is the credential OpenCode itself is
						// pointed at, so the panel can show the two sides
						// agreeing or drifting apart.
						hostActive:
							account.sourceID !== undefined &&
							account.sourceID === readHostActiveSource(db, account.providerID),
						inUse:
							!account.disabled &&
							used?.providerID === account.providerID &&
							used.alias === account.alias,
						lastUsedAt: account.lastUsedAt ?? 0,
						limited,
						limitedReason: limited
							? readLimitedReason(db, account.providerID, account.alias) ||
								// A park from before reasons were kept, or one the
								// host described with no words at all. Saying so is
								// better than a marker that explains nothing.
								"no reason was recorded for this park"
							: "",
						providerID: account.providerID,
					};
				}),
			};
		},

		log: async () => ({ entries: readLog() }),

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

		setBalancing: async (input) => {
			const { enabled } = input as { enabled: boolean };
			setBalancingEnabled(db, enabled);
			recordLog("config", `automatic balancing ${enabled ? "on" : "off"}`);
			return {
				message: `Automatic balancing ${enabled ? "enabled" : "disabled"}.`,
				ok: true,
			};
		},

		setContextTarget: async (input) => {
			const { value } = input as { value: string };
			if (!configPath) {
				return {
					message: "No OpenCode config file to write the limit into.",
					ok: false,
				};
			}

			const typed = value.trim().replace(/%$/, "");
			// Empty means the whole window, which is the absence of a reserve.
			const percent = typed === "" ? 100 : Number(typed);
			if (!(percent >= 1 && percent <= 100)) {
				return {
					message: `"${value}" is not a share from 1% to 100%.`,
					ok: false,
				};
			}

			// The file stores the part kept free, so the host trips at the share
			// the user typed. 100% means no reserve at all.
			const reserve = 100 - percent;
			try {
				if (reserve <= 0) writeCompactionBuffer(configPath, undefined);
				else writeCompactionBuffer(configPath, `${reserve}%`);
			} catch (error) {
				return {
					message:
						error instanceof Error
							? `Could not write the limit: ${error.message}`
							: "Could not write the limit.",
					ok: false,
				};
			}

			// Read back rather than trust the arithmetic: the file is the record.
			const stored = readBufferAt(configPath);
			recordLog(
				"config",
				reserve <= 0
					? "context limit cleared (whole window)"
					: `context limit ${Math.round(targetShare(stored) * 100)}% (${reserveLabel(stored)} kept free)`,
			);

			// The declared window does not move, but a running session reads the
			// limit from its catalog, so both caches are refreshed anyway.
			invalidateCatalog();
			try {
				await refresh?.();
			} catch {
				// Reported as success: the file is the change.
			}
			return {
				message:
					reserve <= 0
						? "Context limit cleared: the whole window is used."
						: `Context limit set to ${Math.round(targetShare(stored) * 100)}%; the config keeps ${reserveLabel(stored)} free.`,
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
			recordLog(
				"config",
				`${providerID} ${enabled ? "free models only" : "paid models too"}`,
			);
			return {
				message: `${providerID} uses ${enabled ? "free models only" : "paid models too"}.`,
				ok: true,
			};
		},

		setRowLimit: async (input) => {
			const { key, value } = input as { key: string; value: string };
			const parsed = parseLimit(value);
			if (!parsed.ok) return { message: parsed.message, ok: false };
			setRowLimit(db, key, parsed.tokens);
			recordLog(
				"config",
				parsed.tokens === undefined
					? `${key} limit cleared`
					: `${key} limited to ${parsed.tokens} tokens`,
			);
			// The catalog is cached, and a new limit must reach the next read of
			// it: the panel redraws from `chains` and routing sizes the row.
			invalidateCatalog();
			// The declared window is what the limit changes, so the host has to
			// rebuild its models for the new number to reach a running session.
			// A host that cannot is fine: the value is already saved.
			try {
				await refresh?.();
			} catch {
				// Reported as success: the stored limit is the change.
			}
			return {
				message:
					parsed.tokens === undefined
						? `Cleared the limit on ${key}.`
						: `${key} is limited to ${parsed.tokens} tokens.`,
				ok: true,
			};
		},

		setTargetLimit: async (input) => {
			const { key, providerID, value } = input as {
				key: string;
				providerID: string;
				value: string;
			};
			const parsed = parseLimit(value);
			if (!parsed.ok) return { message: parsed.message, ok: false };
			setTargetLimit(db, key, providerID, parsed.tokens);
			recordLog(
				"config",
				parsed.tokens === undefined
					? `${key} ${providerID} limit cleared`
					: `${key} ${providerID} limited to ${parsed.tokens} tokens`,
			);
			invalidateCatalog();
			// A per-target limit moves that target's window, so the host has to
			// rebuild its models just as for a row limit.
			try {
				await refresh?.();
			} catch {
				// Reported as success: the stored limit is the change.
			}
			return {
				message:
					parsed.tokens === undefined
						? `Cleared the limit on ${providerID} in ${key}.`
						: `${providerID} in ${key} is limited to ${parsed.tokens} tokens.`,
				ok: true,
			};
		},

		status: async () => {
			const accounts = listAccounts(db);
			return {
				accounts: accounts.length,
				balancing: getBalancingEnabled(db),
				limited: accounts.filter((account) => account.rateLimitedUntil != null)
					.length,
				providers: new Set(accounts.map((account) => account.providerID)).size,
			};
		},

		use: async (input) => {
			const { providerID, alias } = input as Pair;
			try {
				const account = setActiveAccount(db, providerID, alias);
				recordLog("config", `active account ${providerID}/${account.alias}`);
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
