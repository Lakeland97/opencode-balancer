import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	clearAccountPark,
	getActiveAccount,
	listAccounts,
	mostRecentlyUsed,
	readLimitedReason,
	setActiveAccount,
} from "../core/accounts";
import {
	readGlobalPercent,
	readTargetPercent,
	setGlobalPercent,
	setTargetPercent,
} from "../core/context";
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
	type FamilyRoute,
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
 * A share the panel typed. An empty field clears it — for a whole-row default
 * that means back to the built-in one, for a model it means back to following
 * the default. Anything that is not a share from 1% to 100% is refused rather
 * than stored as a NaN that would leave nothing able to hold a conversation.
 */
function parsePercent(
	value: string,
): { ok: true; percent: number | undefined } | { ok: false; message: string } {
	const trimmed = value.trim().replace(/%$/, "");
	if (trimmed === "") return { ok: true, percent: undefined };
	const percent = Number(trimmed);
	if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
		return { message: `"${value}" is not a share from 1% to 100%.`, ok: false };
	}
	return { ok: true, percent };
}

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
			return {
				rows: catalog.families.map((family) => ({
					key: family.key,
					label: family.name,
					package: family.package,
					stored: Boolean(family.stored),
					targets: resolveChain(db, family).map((target) => ({
						modelID: target.modelID,
						// The share of this model's own window, or 0 when it
						// follows the global one.
						percent: readTargetPercent(db, family.key, target.providerID) ?? 0,
						providerID: target.providerID,
						resolved: resolvedModelID(db, target),
						state: targetState(db, family, target),
					})),
				})),
			};
		},

		clearLog: async () => {
			clearLog();
			return { message: "Cleared the log.", ok: true };
		},

		contextPercent: async () => ({ percent: readGlobalPercent(db) }),

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

		setContextPercent: async (input) => {
			const { value } = input as { value: string };
			const parsed = parsePercent(value);
			if (!parsed.ok) return { message: parsed.message, ok: false };
			setGlobalPercent(db, parsed.percent);
			recordLog(
				"config",
				parsed.percent === undefined
					? "context share back to the default"
					: `context share ${parsed.percent}% of the declared window`,
			);
			return {
				message:
					parsed.percent === undefined
						? `Context share is back to the default (${readGlobalPercent(db)}%).`
						: `Context share is ${parsed.percent}% of the declared window.`,
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

		setTargetPercent: async (input) => {
			const { key, providerID, value } = input as {
				key: string;
				providerID: string;
				value: string;
			};
			const parsed = parsePercent(value);
			if (!parsed.ok) return { message: parsed.message, ok: false };
			setTargetPercent(db, key, providerID, parsed.percent);
			recordLog(
				"config",
				parsed.percent === undefined
					? `${key} ${providerID} follows the global share`
					: `${key} ${providerID} compacts at ${parsed.percent}% of its own window`,
			);
			return {
				message:
					parsed.percent === undefined
						? `${providerID} in ${key} follows the global share again.`
						: `${providerID} in ${key} compacts at ${parsed.percent}% of its own window.`,
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
				// Picking an account is the retry it was waiting for: a parked
				// one becomes eligible again, so the marker moves and the next
				// call actually goes there.
				clearAccountPark(db, account.providerID, account.alias);
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
