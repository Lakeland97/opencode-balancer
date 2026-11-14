import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	clearAccountPark,
	getAccount,
	listAccounts,
	mostRecentlyUsed,
	moveAccount,
	orderedAccounts,
	readLimitedReason,
	setAccountEnabled,
	setAccountFreeOnly,
	useAccount,
} from "../core/accounts";
import {
	DEFAULT_PERCENT,
	formatTokens,
	parseBuffer,
	parseLimit,
	readBuffer,
	readLimit,
	readModelLimit,
	type SizeOrShare,
	setBuffer,
	setLimit,
	setModelLimit,
} from "../core/context";
import { getBalancingEnabled, setBalancingEnabled } from "../core/priority";
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
import { chooseRoute } from "./routing";
import { enabledAccounts, selectHealthyAccount } from "./selection";

type Pair = { providerID: string; alias: string };

/**
 * The model a target will actually be sent to.
 *
 * `free` is a property of the credential now, so the row shows the free spelling
 * when the credential that would serve is told to spend nothing, and the id it
 * was configured with otherwise. The walk is the one routing makes: down the
 * credentials in the balancer's order, stopping at the first that can answer, so
 * a free-only credential whose provider has no free spelling is passed over
 * exactly as routing passes it over.
 *
 * A park is not a reason to stop saying it. The park is temporary and the row's
 * `state` already reports it; consulting only *healthy* credentials meant the
 * free spelling vanished the moment the key was parked, which is how the panel
 * stopped telling the user that a free model was the one in play.
 */
function resolvedModelID(db: Database, target: FamilyRoute): string {
	if (target.free !== false) return target.modelID;
	for (const account of enabledAccounts(db, target.providerID)) {
		if (!account.freeOnly) return target.modelID;
		if (target.freeVariant) return target.freeVariant.modelID;
	}
	return target.modelID;
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
	// No healthy credential means the provider is switched off entirely, or every
	// one of its credentials is disabled, parked, or waiting on a cooldown.
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
 * How a limit reads in a sentence: a size in tokens, or a share of the window it
 * is measured against.
 */
function describeLimit(size: SizeOrShare, window: string): string {
	return "tokens" in size
		? formatTokens(size.tokens)
		: `${size.percent}% of ${window}`;
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
					// This model's own limit as typed, or empty when it follows
					// the global one. One value per model: the credential
					// serving it does not change it.
					limit: readModelLimit(db, family.key) ?? "",
					package: family.package,
					stored: Boolean(family.stored),
					targets: resolveChain(db, family).map((target) => ({
						modelID: target.modelID,
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

		contextBuffer: async () => ({ value: readBuffer(db) ?? "" }),

		contextLimit: async () => ({ value: readLimit(db) ?? "" }),

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
						// `active` is not "the provider's one pick": it means the
						// balancer can send to this credential at all — switched
						// on, and not sitting out a park. A provider with two
						// keys has two rows that say so, because that is the
						// question the panel is being asked.
						active: !account.disabled && !limited,
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
			const { providerID, alias, direction } = input as {
				providerID: string;
				alias: string;
				direction: "up" | "down";
			};
			moveAccount(db, providerID, alias, direction === "up" ? -1 : 1);
			return {
				message: `Moved ${providerID}/${alias} ${direction}.`,
				ok: true,
			};
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
			// One entry per credential, in the balancer's order: the panel lists
			// these directly, and the credential — not the provider — is what the
			// order, the switches and the arrows act on.
			return {
				entries: orderedAccounts(db).map((account, position) => ({
					alias: account.alias,
					enabled: !account.disabled,
					freeOnly: account.freeOnly,
					name: names.get(account.providerID) ?? account.providerID,
					position,
					providerID: account.providerID,
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

		setContextBuffer: async (input) => {
			const { value } = input as { value: string };
			const parsed = parseBuffer(value);
			if (!parsed.ok) return { message: parsed.message, ok: false };
			setBuffer(db, value);
			const stored = readBuffer(db);
			recordLog(
				"config",
				stored === undefined
					? "the compaction buffer follows the built-in rule again"
					: `the compaction buffer is ${stored}`,
			);
			return {
				message:
					stored === undefined
						? "the compaction buffer follows the built-in rule again."
						: `the compaction buffer is ${stored}.`,
				ok: true,
			};
		},

		setContextLimit: async (input) => {
			const { value } = input as { value: string };
			const parsed = parseLimit(value);
			if (!parsed.ok) return { message: parsed.message, ok: false };
			setLimit(db, value);
			const where =
				parsed.size && describeLimit(parsed.size, "the declared window");
			recordLog(
				"config",
				where ? `context limit ${where}` : "context limit back to the default",
			);
			return {
				message: where
					? `Context limit is ${where}.`
					: `Context limit is back to the default (${DEFAULT_PERCENT}% of the declared window).`,
				ok: true,
			};
		},

		setEnabled: async (input) => {
			const { providerID, alias, enabled } = input as {
				providerID: string;
				alias: string;
				enabled: boolean;
			};
			setAccountEnabled(db, providerID, alias, enabled);
			recordLog(
				"config",
				`${providerID}/${alias} ${enabled ? "enabled" : "disabled"}`,
			);
			return {
				message: `${providerID}/${alias} ${enabled ? "enabled" : "disabled"}.`,
				ok: true,
			};
		},

		setFreeOnly: async (input) => {
			const { providerID, alias, enabled } = input as {
				providerID: string;
				alias: string;
				enabled: boolean;
			};
			setAccountFreeOnly(db, providerID, alias, enabled);
			recordLog(
				"config",
				`${providerID}/${alias} ${enabled ? "free models only" : "paid models too"}`,
			);
			return {
				message: `${providerID}/${alias} uses ${enabled ? "free models only" : "paid models too"}.`,
				ok: true,
			};
		},

		setModelLimit: async (input) => {
			const { key, value } = input as { key: string; value: string };
			const parsed = parseLimit(value);
			if (!parsed.ok) return { message: parsed.message, ok: false };
			setModelLimit(db, key, value);
			const where = parsed.size && describeLimit(parsed.size, "its own window");
			recordLog(
				"config",
				where
					? `${key} compacts at ${where}`
					: `${key} follows the global limit`,
			);
			return {
				message: where
					? `${key} compacts at ${where}.`
					: `${key} follows the global limit again.`,
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
			const account = getAccount(db, providerID, alias);
			if (!account) {
				return { message: `No credential ${providerID}/${alias}.`, ok: false };
			}
			// Picking a credential is how its provider is told to serve with it:
			// the row moves ahead of that provider's other credentials, and the
			// stored alias names it. Routing reads the order, so the two agree.
			useAccount(db, providerID, alias);
			// It is also the retry a park was waiting for, so a parked credential
			// becomes eligible again and the next call actually goes there.
			clearAccountPark(db, account.providerID, account.alias);
			recordLog("config", `serving with ${providerID}/${account.alias}`);
			return {
				message: `Serving with ${providerID}/${account.alias}.`,
				ok: true,
			};
		},
	});

	return registration;
}
