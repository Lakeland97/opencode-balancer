import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	getActiveAccount,
	listAccounts,
	mostRecentlyUsed,
	setActiveAccount,
	type UsedAccount,
} from "../core/accounts";
import { matchModel } from "../core/models";
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
import type { Account } from "../core/types";
import {
	addTarget,
	findRow,
	removeTarget,
	resetRow,
	rowTargets,
	shiftTarget,
} from "./chain-actions";
import { invalidateCatalog } from "./connectors";
import { syncAccounts } from "./import-credentials";
import { chooseRoute, isProviderEnabled } from "./routing";
import { selectHealthyAccount } from "./selection";

function parseArgs(input: string) {
	return (
		input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) ??
		[]
	);
}

function accountLine(db: Database, account: Account, used?: UsedAccount) {
	const marks: string[] = [];
	const limited = Boolean(
		account.rateLimitedUntil && account.rateLimitedUntil > now(),
	);
	// Only one account served the most recent request; the rest are merely
	// configured. A limited or disabled account is not also "active", which
	// reads as a contradiction next to the parked marker.
	if (
		!account.disabled &&
		used?.providerID === account.providerID &&
		used.alias === account.alias
	) {
		marks.push("in use");
	}
	if (
		!account.disabled &&
		!limited &&
		getActiveAccount(db, account.providerID)?.alias === account.alias
	) {
		marks.push("active");
	}
	if (account.disabled) marks.push("disabled");
	if (limited) {
		const seconds = Math.ceil(((account.rateLimitedUntil ?? 0) - now()) / 1000);
		marks.push(`limited ${seconds}s`);
	}
	const suffix = marks.length > 0 ? `  [${marks.join(", ")}]` : "";
	return `${account.providerID}/${account.alias}${suffix}`;
}

function statusSummary(db: Database) {
	const balancing = getBalancingEnabled(db) ? "on" : "off";
	const accounts = listAccounts(db);
	const providers = new Set(accounts.map((account) => account.providerID));
	const limited = accounts.filter(
		(account) => account.rateLimitedUntil && account.rateLimitedUntil > now(),
	).length;
	return [
		`Automatic balancing: ${balancing}`,
		`Accounts: ${accounts.length} across ${providers.size} provider(s)`,
		`Currently rate limited: ${limited}`,
	].join("\n");
}

function accountList(db: Database, providerID?: string) {
	const accounts = providerID ? listAccounts(db, providerID) : listAccounts(db);
	if (accounts.length === 0) return "No accounts saved.";
	const used = mostRecentlyUsed(db);
	return accounts.map((account) => accountLine(db, account, used)).join("\n");
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
			"  gui                          Open the Desktop panel",
			"  list [provider]              Accounts, with active/limited markers",
			"  status                       Balancing state and account totals",
			"  use <provider> <alias>       Make an account active",
			"  import                       Re-read the credentials OpenCode holds",
			"  on | off                     Toggle automatic failover",
			"  priority                     Provider order and on/off state",
			"  chain <model>                Targets for a row, in the order they are tried",
			"  chain <model> add <provider> <model>",
			"  chain <model> remove|up|down <provider>",
			"  chain <model> reset          Hand the row back to provider priority",
			"  enable <provider> | disable <provider>",
			"  free <provider> on | off     Use only that provider's free models",
			"  up <provider> | down <provider>",
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
		try {
			const account = setActiveAccount(db, providerID, alias);
			return `Active account changed to ${providerID}/${account.alias}`;
		} catch (error) {
			return error instanceof Error ? error.message : "Account not found.";
		}
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
		setBalancingEnabled(db, true);
		return "Automatic balancing enabled.";
	}

	if (action === "off") {
		setBalancingEnabled(db, false);
		return "Automatic balancing disabled.";
	}

	if (action === "priority") {
		const entries = listProviderPriority(db);
		if (entries.length === 0) return "No providers saved.";
		return entries
			.map(
				(entry, index) =>
					`${index + 1}. ${entry.providerID}  ${entry.enabled ? "on" : "off"}${
						isFreeOnly(db, entry.providerID) ? "  free-only" : ""
					}`,
			)
			.join("\n");
	}

	if (action === "chain") {
		const [query, ...rest] = args;
		if (!query) {
			return "Usage: /balancer chain <model> [add|remove|up|down|reset] …";
		}
		const family = await findRow(ctx, db, query);
		if (!family) return `No row matches "${query}".`;

		const [verb, providerID, ...modelWords] = rest;

		if (!verb) {
			const live = chooseRoute(db, family);
			const lines = rowTargets(db, family).map((target, index) => {
				const marks: string[] = [];
				if (
					live?.providerID === target.providerID &&
					live.modelID === target.modelID
				) {
					marks.push("next");
				}
				if (!isProviderEnabled(db, target.providerID)) marks.push("disabled");
				const account = selectHealthyAccount(db, target.providerID);
				if (!account) marks.push("no healthy account");
				else if (account.rateLimitedUntil && account.rateLimitedUntil > now()) {
					marks.push("limited");
				}
				const suffix = marks.length > 0 ? `  [${marks.join(", ")}]` : "";
				return `  ${index + 1}. ${target.providerID}  ${target.modelID}${suffix}`;
			});
			return [
				`${family.name} (${family.key}) — ${family.stored ? "custom order" : "automatic order"}`,
				...lines,
			].join("\n");
		}

		if (verb === "reset") {
			return resetRow(db, family)
				? `${family.key} is back to automatic order.`
				: `${family.key} was already automatic.`;
		}

		if (verb === "add") {
			if (!providerID || modelWords.length === 0) {
				return "Usage: /balancer chain <model> add <provider> <model>";
			}
			const result = await addTarget(
				ctx,
				db,
				family,
				providerID,
				modelWords.join(" "),
			);
			return result.message;
		}

		if (!providerID) {
			return `Usage: /balancer chain <model> ${verb} <provider>`;
		}

		if (verb === "remove") return removeTarget(db, family, providerID).message;

		if (verb === "up" || verb === "down") {
			return shiftTarget(db, family, providerID, verb).message;
		}

		return `Unknown chain action: ${verb}.`;
	}

	if (action === "free") {
		const [providerID, toggle] = args;
		if (!providerID || (toggle !== "on" && toggle !== "off")) {
			return "Usage: /balancer free <provider> on | off";
		}
		setFreeOnly(db, providerID, toggle === "on");
		invalidateCatalog();
		return `${providerID} uses ${toggle === "on" ? "free models only" : "paid models too"}.`;
	}

	if (action === "enable" || action === "disable") {
		const [providerID] = args;
		if (!providerID) return `Usage: /balancer ${action} <provider>`;
		setProviderEnabled(db, providerID, action === "enable");
		return `${providerID} ${action}d.`;
	}

	if (action === "up" || action === "down") {
		const [providerID] = args;
		if (!providerID) return `Usage: /balancer ${action} <provider>`;
		moveProvider(db, providerID, action === "up" ? -1 : 1);
		return `Moved ${providerID} ${action}.`;
	}

	return `Unknown command: ${action}. Use /balancer help.`;
}
