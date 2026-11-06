import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin";
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
import type { Account } from "../core/types";
import { readActiveCredential } from "./credentials";

function parseArgs(input: string) {
	return (
		input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) ??
		[]
	);
}

function accountLine(db: Database, account: Account) {
	const marks: string[] = [];
	const active = getActiveAccount(db, account.providerID);
	if (active?.alias === account.alias) marks.push("active");
	if (account.disabled) marks.push("disabled");
	if (account.rateLimitedUntil && account.rateLimitedUntil > now()) {
		const seconds = Math.ceil((account.rateLimitedUntil - now()) / 1000);
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
	const accounts = providerID
		? listAccounts(db, providerID)
		: listAccounts(db);
	if (accounts.length === 0) return "No accounts saved.";
	return accounts.map((account) => accountLine(db, account)).join("\n");
}

export async function runCommand({
	ctx,
	db,
	raw,
}: {
	ctx: Context;
	db: Database;
	raw: string;
}) {
	const [action = "", ...args] = parseArgs(raw);

	// A bare /balancer is the common case: show state, not a command dump.
	if (!action) {
		return [statusSummary(db), "", accountList(db)].join("\n");
	}

	if (["help", "--help", "-h"].includes(action)) {
		return [
			"Balancer commands:",
			"  list [provider]              Accounts, with active/limited markers",
			"  status                       Balancing state and account totals",
			"  add <provider> <alias>       Save the provider's current credential as an account",
			"  use <provider> <alias>       Make an account active",
			"  remove <provider> <alias>    Delete a saved account",
			"  rename <provider> <alias> <new>",
			"  on | off                     Toggle automatic failover",
			"  priority                     Provider priority and chosen models",
			"  model <provider> <modelID>   Model used when that provider is selected",
			"  enable <provider> | disable <provider>",
			"  up <provider> | down <provider>",
		].join("\n");
	}

	if (action === "list") {
		return accountList(db, args[0]);
	}

	if (action === "status") {
		return statusSummary(db);
	}

	if (action === "add" || action === "import") {
		const [providerID, alias] = args;
		if (!providerID || !alias) return "Usage: /balancer add <provider> <alias>";
		try {
			const auth = await readActiveCredential(ctx, providerID);
			if (!auth) {
				return `No usable active credential for ${providerID}. Connect the provider in opencode first.`;
			}
			const account = saveAccount(db, providerID, alias, auth);
			return `Saved ${account.providerID}/${account.alias}.`;
		} catch (error) {
			return error instanceof Error ? error.message : "Could not save account.";
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
		const [providerID, alias] = args;
		if (!providerID || !alias) return "Usage: /balancer remove <provider> <alias>";
		const removed = removeAccount(db, providerID, alias);
		return removed
			? `Removed ${providerID}/${alias}.`
			: `No account ${providerID}/${alias}.`;
	}

	if (action === "rename") {
		const [providerID, alias, next] = args;
		if (!providerID || !alias || !next) {
			return "Usage: /balancer rename <provider> <alias> <newAlias>";
		}
		try {
			const account = renameAccount(db, providerID, alias, next);
			return `Renamed to ${providerID}/${account.alias}.`;
		} catch (error) {
			return error instanceof Error ? error.message : "Rename failed.";
		}
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
			.map((entry, index) => {
				const model = entry.modelID ?? "(no model)";
				const state = entry.enabled ? "on" : "off";
				return `${index + 1}. ${entry.providerID}  ${state}  ${model}`;
			})
			.join("\n");
	}

	if (action === "model") {
		const [providerID, modelID] = args;
		if (!providerID || !modelID) {
			return "Usage: /balancer model <provider> <modelID>";
		}
		setProviderModel(db, providerID, modelID);
		setSelectedModel(db, providerID, modelID);
		return `Model for ${providerID} set to ${modelID}.`;
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
