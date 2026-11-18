import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import { copy } from "../copy";
import {
	listAccounts,
	mostRecentlyUsed,
	orderedAccounts,
	readLimitedReason,
	readLimitedUntil,
} from "../core/accounts";
import { readBuffer, readBufferEnforcement, readLimit } from "../core/context";
import { getBalancingEnabled } from "../core/priority";
import { getRebalanceAuto, readRebalance } from "../core/rebalance";
import { Balancer } from "../rpc";
import { listChainRows } from "./chain-actions";
import { nextRebalanceAt } from "./hooks";
import { clearLog, readLog } from "./log";
import { servedEntries } from "./route-memory";
import {
	writeBalancing,
	writeBufferEnforcement,
	writeContextBuffer,
	writeContextLimit,
	writeModelLimit,
	writeRebalance,
	writeRebalanceAuto,
} from "./settings";
import {
	writeChainAdd,
	writeChainCreate,
	writeChainMove,
	writeChainRemove,
	writeChainReset,
	writeMove,
	writeSetEnabled,
	writeSetFreeOnly,
	writeUse,
} from "./writes";

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
	const registration = await ctx.rpc.register(Balancer, {
		chainAdd: async (input) => {
			const { key, providerID, modelID } = input as {
				key: string;
				providerID: string;
				modelID: string;
			};
			return writeChainAdd(ctx, db, { key, modelID, providerID });
		},

		chainCreate: async (input) => {
			const { providerID, modelID } = input as {
				providerID: string;
				modelID: string;
			};
			return writeChainCreate(ctx, db, { modelID, providerID });
		},

		chainModels: async (input) => {
			const { providerID, package: wire } = input as {
				providerID: string;
				package?: string;
			};
			const list = await ctx.model.list();
			return {
				models: list.data
					.filter(
						(model) =>
							model.providerID === providerID &&
							(!model.type || model.type === "chat") &&
							model.enabled !== false &&
							typeof model.settings?.baseURL === "string" &&
							// A row speaks one wire format; a model from another
							// would be refused when it was added, so it must not be
							// offered in the first place.
							(wire === undefined || (model.package ?? "") === wire),
					)
					.map((model) => ({
						modelID: model.modelID,
						name: model.name ?? model.modelID,
					})),
			};
		},

		chainMove: async (input) => {
			const { key, providerID, to, direction } = input as {
				key: string;
				providerID: string;
				direction?: "up" | "down";
				to?: number;
			};
			return writeChainMove(ctx, db, { direction, key, providerID, to });
		},

		chainRemove: async (input) => {
			const { key, providerID } = input as {
				key: string;
				providerID: string;
			};
			return writeChainRemove(ctx, db, { key, providerID });
		},

		chainReset: async (input) => {
			const { key } = input as { key: string };
			return writeChainReset(ctx, db, key);
		},

		chains: async () => ({
			rows: await listChainRows(ctx, db),
		}),

		clearLog: async () => {
			clearLog();
			return { message: "Cleared the log.", ok: true };
		},

		contextBuffer: async () => ({
			enforce: readBufferEnforcement(db),
			value: readBuffer(db) ?? "",
		}),

		contextLimit: async () => ({ value: readLimit(db) ?? "" }),

		// Which rows are being served right now, and by what. Read from the same
		// notes the chain rows use, so the panel and this answer cannot disagree;
		// more than one row at once is normal when a model split across providers
		// after a limit.
		inUse: async () => {
			const rows = await listChainRows(ctx, db);
			const byKey = new Map(rows.map((row) => [row.key, row]));
			return {
				entries: servedEntries(db).map((entry) => ({
					agent: entry.agent ?? "",
					alias: entry.alias ?? "",
					applied: entry.applied ?? "",
					at: entry.at,
					familyKey: entry.familyKey,
					label: byKey.get(entry.familyKey)?.label ?? entry.familyKey,
					modelID: entry.modelID,
					providerID: entry.providerID,
					variant: entry.variant ?? "",
				})),
			};
		},

		list: async (input) => {
			const { providerID } = (input ?? {}) as { providerID?: string };
			const accounts = providerID
				? listAccounts(db, providerID)
				: listAccounts(db);
			// Several credentials can be in use at once: each model row is served
			// by whichever target answered it, so two rows on two providers are
			// two credentials doing work. The global most-recent credential is
			// the fallback for a provider none of the row notes names.
			const used = mostRecentlyUsed(db);
			const serving = new Set(
				servedEntries(db).map(
					(entry) => `${entry.providerID}\u0000${entry.alias ?? ""}`,
				),
			);
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
							(serving.has(`${account.providerID}\u0000${account.alias}`) ||
								(used?.providerID === account.providerID &&
									used.alias === account.alias)),
						lastUsedAt: account.lastUsedAt ?? 0,
						limited,
						limitedReason: limited
							? readLimitedReason(db, account.providerID, account.alias) ||
								// A park from before reasons were kept, or one the
								// host described with no words at all. Saying so is
								// better than a marker that explains nothing.
								copy.noReason
							: "",
						// When the provider said its own quota comes back, in
						// milliseconds, or 0 when it did not say. Evidence from the
						// endpoint, not this park's expiry: the marker is still
						// cleared by the next attempt rather than by this clock.
						limitedUntil: limited
							? (readLimitedUntil(db, account.providerID, account.alias) ?? 0)
							: 0,
						providerID: account.providerID,
					};
				}),
			};
		},

		log: async () => ({ entries: readLog() }),

		move: async (input) => {
			const { providerID, alias, to, direction } = input as {
				providerID: string;
				alias: string;
				direction?: "up" | "down";
				to?: number;
			};
			return writeMove(db, { alias, direction, providerID, to });
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

		rebalance: async () => ({
			// Whether idleness drops a trail at all, and the length it would drop
			// it after. The length is reported even when the switch is off, so the
			// field keeps showing what turning the switch back on would restore.
			auto: getRebalanceAuto(db),
			// When the client's balance next lapses, in ms, or 0 when nothing is
			// counting down. The panel shows it as "(in 4h 12m)", which is the
			// question the field is actually asking.
			nextAt: nextRebalanceAt(db) ?? 0,
			// As typed, empty when it has never been set: the field's placeholder
			// then shows the built-in default rather than pretending it was typed.
			value: readRebalance(db) ?? "",
		}),

		setBalancing: async (input) => {
			const { enabled } = input as { enabled: boolean };
			return writeBalancing(db, enabled);
		},

		setBufferEnforce: async (input) => {
			const { value } = input as { value: string };
			return writeBufferEnforcement(db, value);
		},

		setContextBuffer: async (input) => {
			const { value } = input as { value: string };
			return writeContextBuffer(db, value);
		},

		setContextLimit: async (input) => {
			const { value } = input as { value: string };
			return writeContextLimit(db, value);
		},

		setEnabled: async (input) => {
			const { providerID, alias, enabled } = input as {
				providerID: string;
				alias: string;
				enabled: boolean;
			};
			return writeSetEnabled(db, { alias, enabled, providerID });
		},

		setFreeOnly: async (input) => {
			const { providerID, alias, enabled } = input as {
				providerID: string;
				alias: string;
				enabled: boolean;
			};
			return writeSetFreeOnly(db, { alias, enabled, providerID });
		},

		setModelLimit: async (input) => {
			const { key, value } = input as { key: string; value: string };
			return writeModelLimit(db, key, value);
		},

		setRebalance: async (input) => {
			const { value } = input as { value: string };
			return writeRebalance(db, value);
		},

		setRebalanceAuto: async (input) => {
			const { enabled } = input as { enabled: boolean };
			return writeRebalanceAuto(db, enabled);
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
			return writeUse(db, { alias, providerID });
		},
	});

	return registration;
}
