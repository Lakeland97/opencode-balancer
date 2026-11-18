import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import { copy } from "../copy";
import {
	getAccount,
	getActiveAccount,
	listAccounts,
	mostRecentlyUsed,
	orderedAccounts,
	readLimitedReason,
	readLimitedUntil,
	type UsedAccount,
} from "../core/accounts";
import {
	cutFor,
	DEFAULT_PERCENT,
	formatTokens,
	readBuffer,
	readBufferEnforcement,
	readLimit,
} from "../core/context";
import { credentialNote, formatAttempt, routeMarkers } from "../core/format";
import { matchModel } from "../core/models";
import { storePath } from "../core/path";
import { getBalancingEnabled } from "../core/priority";
import {
	formatDuration,
	getRebalanceAuto,
	readRebalance,
	rebalanceAfterMs,
} from "../core/rebalance";
import type { Account } from "../core/types";
import { findRow, listChainRows } from "./chain-actions";
import { invalidateCatalog } from "./connectors";
import { syncAccounts } from "./import-credentials";
import { clearLog, readLog } from "./log";
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

function parseArgs(input: string) {
	return (
		input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) ??
		[]
	);
}

function accountNote(db: Database, account: Account) {
	return credentialNote({
		limited: account.rateLimitedUntil != null,
		limitedUntil: readLimitedUntil(db, account.providerID, account.alias),
		reason: readLimitedReason(db, account.providerID, account.alias),
		resets: copy.resets,
	});
}

function accountLine(db: Database, account: Account, used?: UsedAccount) {
	const limited = account.rateLimitedUntil != null;
	// A park is cleared by the next attempt, so any park at all reads as
	// limited. `active` means the balancer can route to the credential: switched
	// on and not sitting out a failure. A provider with two keys has two active
	// rows, which is the question `list` is answering.
	const marks: string[] = routeMarkers({
		active: !account.disabled && !limited,
		inUse:
			!account.disabled &&
			used?.providerID === account.providerID &&
			used.alias === account.alias,
		limited,
	}).map((marker) => copy[marker]);
	if (account.disabled) marks.push("disabled");
	const suffix = marks.length > 0 ? `  [${marks.join(", ")}]` : "";
	const note = accountNote(db, account);
	return `${account.providerID}/${account.alias}${suffix}${
		note ? `  ${note}` : ""
	}`;
}

function statusSummary(db: Database) {
	const balancing = getBalancingEnabled(db) ? "on" : "off";
	const accounts = listAccounts(db);
	const providers = new Set(accounts.map((account) => account.providerID));
	// Any park counts: the credential failed and has not been tried since. An
	// expired park is still a state the user has to see, not a silent zero.
	const limited = accounts.filter(
		(account) => account.rateLimitedUntil != null,
	).length;
	return [
		`Automatic balancing: ${balancing}`,
		`Accounts: ${accounts.length} across ${providers.size} provider(s)`,
		`Currently rate limited: ${limited}`,
	].join("\n");
}

/**
 * The settings summary the panel and `settings`/`diag` share: what is stored,
 * and the cut it actually produces.
 */
function settingsLines(db: Database) {
	const limit = readLimit(db);
	const buffer = readBuffer(db);
	const enforcement = readBufferEnforcement(db);
	const stored = readRebalance(db);
	const cut = cutFor(limit ?? "", buffer ?? "", enforcement);
	const auto = getRebalanceAuto(db);
	const effective = auto ? formatDuration(rebalanceAfterMs(db)) : "off";
	// The switch and the stored length are separate facts. Hiding the length
	// while the switch is off loses a value the panel still shows; printing it
	// again when it is exactly what is running adds nothing.
	const storedNote = stored && stored !== effective ? `  stored ${stored}` : "";
	return [
		`Automatic balancing: ${getBalancingEnabled(db) ? "on" : "off"}`,
		`Context limit: ${
			limit ?? `default (${DEFAULT_PERCENT}% of the declared window)`
		}`,
		`Buffer: ${buffer ?? "built-in"}`,
		`Enforcement: ${enforcement}`,
		`Rebalance after: ${effective}${storedNote}`,
		`Cut at ${formatTokens(cut) || "—"}`,
	];
}

/** Credentials sitting out a park, whether or not its clock has run out. */
function errorList(db: Database) {
	const accounts = orderedAccounts(db).filter(
		(account) => account.rateLimitedUntil != null,
	);
	if (accounts.length === 0) {
		return "No credential is sitting out a rate limit.";
	}
	const used = mostRecentlyUsed(db);
	return accounts
		.map((account) => {
			// The same markers the `list` row carries: a parked credential that
			// served the last request is both in use and limited, and a disabled
			// one keeps its switch word.
			const marks: string[] = routeMarkers({
				active: false,
				inUse:
					!account.disabled &&
					used?.providerID === account.providerID &&
					used.alias === account.alias,
				limited: true,
			}).map((marker) => copy[marker]);
			if (account.disabled) marks.push("disabled");
			// The panel never leaves a park unexplained; the fallback reason says
			// so when the endpoint gave no words at all.
			const note = credentialNote({
				limited: true,
				limitedUntil: readLimitedUntil(db, account.providerID, account.alias),
				reason:
					readLimitedReason(db, account.providerID, account.alias) ||
					copy.noReason,
				resets: copy.resets,
			});
			return [
				`${account.providerID}/${account.alias}  [${marks.join(", ")}]`,
				...(note ? [`  ${note}`] : []),
				`  last tried ${formatAttempt(account.lastUsedAt)}`,
			].join("\n");
		})
		.join("\n\n");
}

/**
 * The rows worth listing as chains: every custom row, plus an automatic row
 * only when it has more than one target, because a single-target automatic row
 * says nothing the credential list does not.
 */
async function chainList(ctx: Context, db: Database) {
	const rows = (await listChainRows(ctx, db))
		.filter((row) => row.stored || row.targets.length > 1)
		.sort((a, b) =>
			a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
		);
	if (rows.length === 0) {
		return "No custom chains; every row follows the credential order.";
	}
	return rows
		.map((row) =>
			[
				row.key,
				row.label,
				row.limit ? `limit ${row.limit}` : "global",
				row.stored ? "custom" : "automatic",
				`${row.targets.length} target${row.targets.length === 1 ? "" : "s"}`,
			].join(" — "),
		)
		.join("\n");
}

function accountList(db: Database, providerID?: string) {
	// The order is the routing order, so the list reads as what would be tried
	// first rather than alphabetically.
	const accounts = orderedAccounts(db, providerID);
	if (accounts.length === 0) return "No accounts saved.";
	const used = mostRecentlyUsed(db);
	return accounts.map((account) => accountLine(db, account, used)).join("\n");
}

/**
 * The credentials a command names. A bare provider means every credential it
 * has — `free opencode off` is the whole account, not an arbitrary one of them —
 * and `provider/alias` means exactly that credential.
 */
function namedAccounts(db: Database, token: string): Account[] {
	const slash = token.indexOf("/");
	if (slash === -1) return orderedAccounts(db, token);
	const account = getAccount(db, token.slice(0, slash), token.slice(slash + 1));
	return account ? [account] : [];
}

type ResolvedModel = { modelID: string; name?: string } | { error: string };

/**
 * Turns what the picker shows into the provider's own model id. Connectors name
 * the same model differently (`DeepSeek V4.1 Flash 1017` vs
 * `deepseek/deepseek-v4.1-flash`), so an exact id is only the strongest match,
 * not the only one.
 */
async function resolveModel(
	ctx: Context,
	providerID: string,
	query: string,
): Promise<ResolvedModel> {
	const list = await ctx.model.list();
	const candidates = list.data
		.filter((model) => model.providerID === providerID)
		.map((model) => ({ modelID: model.modelID, name: model.name }));
	if (candidates.length === 0) {
		return { error: `No models are available for ${providerID}.` };
	}
	const match = matchModel(query, candidates);
	if (!match) {
		return { error: `No ${providerID} model matches "${query}".` };
	}
	if (match.score < 4 && match.ties.length > 1) {
		return {
			error: [
				`"${query}" matches ${match.ties.length} ${providerID} models:`,
				...match.ties.map((model) => `  ${model.modelID}  (${model.name})`),
				"Use the exact id.",
			].join("\n"),
		};
	}
	return match.model;
}

export async function runCommand({
	ctx,
	db,
	raw,
	openGui,
}: {
	ctx: Context;
	db: Database;
	raw: string;
	openGui?: () => Promise<void>;
}) {
	const [action = "", ...args] = parseArgs(raw);

	// A bare /balancer is the common case: show state, not a command dump.
	if (!action) {
		return [statusSummary(db), "", accountList(db)].join("\n");
	}

	if (["help", "--help", "-h"].includes(action)) {
		return [
			"Balancer commands:",
			"  gui                          Open the Balancer panel",
			"  list [provider]              Credentials, in the order they are tried",
			"  status                       Balancing state and account totals",
			"  errors                       Credentials sitting out a rate limit, with refills",
			"  settings                     Limits, buffer and the cut they produce",
			"  chains                       Custom rows, or automatic rows with several targets",
			"  log [n] | log clear          Recent decisions, or clear the log",
			"  diag                         Store path, counts and settings",
			"  use <provider> <alias>       Serve this provider with that credential",
			"  import                       Re-read the credentials OpenCode holds",
			"  on | off                     Toggle automatic failover",
			"  limit <value|default>        Context limit as a size or a share",
			"  buffer <value|default> [always|necessary]",
			"  buffer <always|necessary>    Change only when the buffer applies",
			"  rebalance on [length] | off | <length> | default",
			"  priority                     Credential order, with each one's switches",
			"  chain <model>                Targets for a row, in the order they are tried",
			"  chain <model> add <provider> <model>",
			"  chain <model> remove|up|down <provider>",
			"  chain <model> limit <value|default>",
			"  chain <model> reset          Hand the row back to the credential order",
			"  create <provider> <model>    Start a custom row from one model",
			"  enable <credential> | disable <credential>",
			"  free <credential> on | off   Use only that credential's free models",
			"  up <credential> | down <credential>",
			"  <credential> is <provider>, meaning all its credentials, or <provider>/<alias>.",
		].join("\n");
	}

	if (action === "gui") {
		if (!openGui) return "The Desktop panel is not available in this client.";
		await openGui();
		return "Opening the Balancer panel. If it stays closed, use the command palette: Open Balancer.";
	}

	if (action === "list") {
		return accountList(db, args[0]);
	}

	if (action === "status") {
		return statusSummary(db);
	}

	if (action === "errors") {
		return errorList(db);
	}

	if (action === "settings") {
		return settingsLines(db).join("\n");
	}

	if (action === "chains") {
		return chainList(ctx, db);
	}

	if (action === "log") {
		const [verb, ...rest] = args;
		if (rest.length > 0) return "Usage: /balancer log [n] | log clear";
		if (verb === "clear") {
			clearLog();
			return "Cleared the log.";
		}
		if (verb !== undefined && !/^\d+$/.test(verb)) {
			return "Usage: /balancer log [n] | log clear";
		}
		const entries = readLog();
		if (entries.length === 0) return "The log is empty.";
		const wanted = verb ? Number.parseInt(verb, 10) : 50;
		const take = Number.isFinite(wanted) && wanted > 0 ? wanted : 50;
		return entries
			.slice(-take)
			.map(
				(entry) =>
					`${new Date(entry.at).toTimeString().slice(0, 8)} ${entry.text}`,
			)
			.join("\n");
	}

	if (action === "diag") {
		const accounts = listAccounts(db);
		// Diagnostics must survive the very failure that makes them useful. A
		// missing catalogue costs the row count, not the store path or settings.
		let rows: Awaited<ReturnType<typeof listChainRows>> | undefined;
		let catalogueError = "";
		try {
			rows = await listChainRows(ctx, db);
		} catch (error) {
			catalogueError = error instanceof Error ? error.message : String(error);
		}
		const visible = rows?.filter(
			(row) => row.stored || row.targets.length > 1,
		).length;
		const logs = readLog().length;
		return [
			`Store: ${storePath()}`,
			`${accounts.length} credential${accounts.length === 1 ? "" : "s"}, ${
				visible ?? "?"
			} row${visible === 1 ? "" : "s"}, ${logs} log entr${
				logs === 1 ? "y" : "ies"
			}`,
			...settingsLines(db),
			...(catalogueError ? [`rows unavailable: ${catalogueError}`] : []),
		].join("\n");
	}

	if (action === "limit") {
		if (args.length !== 1) return "Usage: /balancer limit <value|default>";
		const value = args[0];
		return writeContextLimit(db, value === "default" ? "" : value).message;
	}

	if (action === "buffer") {
		const [first, second] = args;
		const usage =
			"Usage: /balancer buffer <value|default> [always|necessary], or /balancer buffer <always|necessary>";
		if (!first || args.length > 2) return usage;
		const enforcementOnly = first === "always" || first === "necessary";
		if (enforcementOnly && second) return usage;
		const enforcement = enforcementOnly ? first : second;
		if (
			enforcement &&
			enforcement !== "always" &&
			enforcement !== "necessary"
		) {
			return usage;
		}
		const messages: string[] = [];
		if (!enforcementOnly) {
			// The value is validated and written before the enforcement choice is
			// touched, so a typo in either half leaves both as they were.
			const result = writeContextBuffer(db, first === "default" ? "" : first);
			if (!result.ok) return result.message;
			messages.push(result.message);
		}
		if (enforcement) {
			messages.push(writeBufferEnforcement(db, enforcement).message);
		}
		return messages.join("\n");
	}

	if (action === "rebalance") {
		const [first, ...rest] = args;
		const usage =
			"Usage: /balancer rebalance on [length] | off | <length> | default";
		if (!first) return usage;
		if (first === "off") {
			if (rest.length > 0) return usage;
			return writeRebalanceAuto(db, false).message;
		}
		if (first === "on") {
			if (rest.length > 0) {
				if (rest.length > 1) return usage;
				return writeRebalance(db, rest[0]).message;
			}
			return writeRebalanceAuto(db, true).message;
		}
		if (rest.length > 0) return usage;
		// `default` clears the stored length; any other word is a length the
		// duration grammar either accepts or refuses with its own message.
		return writeRebalance(db, first === "default" ? "" : first).message;
	}

	if (action === "create") {
		const [providerID, ...modelWords] = args;
		if (!providerID || modelWords.length === 0) {
			return "Usage: /balancer create <provider> <model>";
		}
		const result = await writeChainCreate(ctx, db, {
			modelID: modelWords.join(" "),
			providerID,
		});
		return result.message;
	}

	if (action === "add" || action === "import") {
		// Accounts mirror the credentials OpenCode holds, so this is a re-read
		// rather than a way to type one in.
		try {
			const result = await syncAccounts(ctx, db);
			invalidateCatalog();
			const parts = [
				`${result.imported} credential${result.imported === 1 ? "" : "s"} seen`,
			];
			if (result.pruned > 0) parts.push(`${result.pruned} removed`);
			return `${parts.join(", ")}. Accounts follow OpenCode: connect a provider there and it appears here.`;
		} catch (error) {
			return error instanceof Error
				? error.message
				: "Could not read credentials.";
		}
	}

	if (action === "use") {
		const [providerID, alias] = args;
		if (!providerID || !alias) return "Usage: /balancer use <provider> <alias>";
		return writeUse(db, { alias, providerID }).message;
	}

	if (action === "active") {
		const [providerID] = args;
		if (!providerID) return "Usage: /balancer active <provider>";
		const account = getActiveAccount(db, providerID);
		if (!account) return "No active account for provider.";
		return `${providerID}/${account.alias}`;
	}

	if (action === "remove") {
		return "Accounts follow OpenCode: remove the credential there and it disappears here on the next sync.";
	}

	if (action === "rename") {
		return "Accounts follow OpenCode: rename the credential there and the account follows it.";
	}

	if (action === "on") {
		return writeBalancing(db, true).message;
	}

	if (action === "off") {
		return writeBalancing(db, false).message;
	}

	if (action === "priority") {
		const entries = orderedAccounts(db);
		if (entries.length === 0) return "No providers saved.";
		const used = mostRecentlyUsed(db);
		return entries
			.map((account, index) => {
				const limited = account.rateLimitedUntil != null;
				const marks: string[] = routeMarkers({
					active: !account.disabled && !limited,
					inUse:
						!account.disabled &&
						used?.providerID === account.providerID &&
						used.alias === account.alias,
					limited,
				}).map((marker) => copy[marker]);
				if (account.disabled) marks.push("disabled");
				return `${index + 1}. ${account.providerID}/${account.alias}  [${marks.join(
					", ",
				)}]${account.freeOnly ? "  free-only" : ""}`;
			})
			.join("\n");
	}

	if (action === "chain") {
		const [query, ...rest] = args;
		if (!query) {
			return "Usage: /balancer chain <model> [add|remove|up|down|reset] …";
		}
		const resolved = await findRow(ctx, db, query);
		if (!resolved) return `No row matches "${query}".`;
		if (resolved.kind === "ambiguous") {
			return [
				`"${query}" matches ${resolved.ties.length} rows:`,
				...resolved.ties.map((family) => `  ${family.key}  (${family.name})`),
				"Use the exact key.",
			].join("\n");
		}
		const family = resolved.family;

		const [verb, providerID, ...modelWords] = rest;

		if (!verb) {
			const row = (await listChainRows(ctx, db)).find(
				(entry) => entry.key === family.key,
			);
			const lines = (row?.targets ?? []).map((target, index) => {
				const resolved =
					target.resolved !== target.modelID ? ` → ${target.resolved}` : "";
				return `  ${index + 1}. ${target.providerID}  ${target.modelID}${resolved}  [${target.state}]`;
			});
			return [
				`${family.name} (${family.key}) — ${family.stored ? "custom order" : "automatic order"} — ${row?.limit ? `limit ${row.limit}` : "global"}`,
				...lines,
			].join("\n");
		}

		if (verb === "reset") {
			return (await writeChainReset(ctx, db, family.key)).message;
		}

		if (verb === "limit") {
			const words = [providerID, ...modelWords].filter(Boolean);
			if (words.length === 0) {
				return "Usage: /balancer chain <model> limit <value|default>";
			}
			const value = words.join(" ");
			return writeModelLimit(db, family.key, value === "default" ? "" : value)
				.message;
		}

		if (verb === "add") {
			if (!providerID || modelWords.length === 0) {
				return "Usage: /balancer chain <model> add <provider> <model>";
			}
			const result = await writeChainAdd(ctx, db, {
				key: family.key,
				modelID: modelWords.join(" "),
				providerID,
			});
			return result.message;
		}

		if (!providerID) {
			return `Usage: /balancer chain <model> ${verb} <provider>`;
		}

		if (verb === "remove") {
			return (
				await writeChainRemove(ctx, db, {
					key: family.key,
					providerID,
				})
			).message;
		}

		if (verb === "up" || verb === "down") {
			return (
				await writeChainMove(ctx, db, {
					direction: verb,
					key: family.key,
					providerID,
				})
			).message;
		}

		return `Unknown chain action: ${verb}.`;
	}

	if (action === "free") {
		const [token, toggle] = args;
		if (!token || (toggle !== "on" && toggle !== "off")) {
			return "Usage: /balancer free <credential> on | off";
		}
		const targets = namedAccounts(db, token);
		if (targets.length === 0) return `No credential matches "${token}".`;
		for (const account of targets) {
			writeSetFreeOnly(db, {
				alias: account.alias,
				enabled: toggle === "on",
				providerID: account.providerID,
			});
		}
		return `${targets.length} credential${targets.length === 1 ? "" : "s"} use ${
			toggle === "on" ? "free models only" : "paid models too"
		}.`;
	}

	if (action === "enable" || action === "disable") {
		const [token] = args;
		if (!token) return `Usage: /balancer ${action} <credential>`;
		const targets = namedAccounts(db, token);
		if (targets.length === 0) return `No credential matches "${token}".`;
		for (const account of targets) {
			writeSetEnabled(db, {
				alias: account.alias,
				enabled: action === "enable",
				providerID: account.providerID,
			});
		}
		return `${targets.length} credential${targets.length === 1 ? "" : "s"} ${
			action === "enable" ? "enabled" : "disabled"
		}.`;
	}

	if (action === "up" || action === "down") {
		const [token] = args;
		if (!token) return `Usage: /balancer ${action} <provider>/<alias>`;
		// Moving is only meaningful for one credential: `down` on a whole
		// provider would have to guess which of its rows the user pointed at.
		const targets = namedAccounts(db, token);
		if (targets.length === 0) return `No credential matches "${token}".`;
		if (targets.length > 1) {
			return `Say which credential: /balancer ${action} <provider>/<alias>.`;
		}
		const [account] = targets;
		return writeMove(db, {
			alias: account.alias,
			direction: action,
			providerID: account.providerID,
		}).message;
	}

	return `Unknown command: ${action}. Use /balancer help.`;
}
