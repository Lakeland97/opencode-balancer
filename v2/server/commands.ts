import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	clearAccountPark,
	getAccount,
	getActiveAccount,
	listAccounts,
	mostRecentlyUsed,
	moveAccount,
	orderedAccounts,
	setAccountEnabled,
	setAccountFreeOnly,
	type UsedAccount,
	useAccount,
} from "../core/accounts";
import { matchModel } from "../core/models";
import { getBalancingEnabled, setBalancingEnabled } from "../core/priority";
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
import { chooseRoute } from "./routing";
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
			"  gui                          Open the Desktop panel",
			"  list [provider]              Credentials, in the order they are tried",
			"  status                       Balancing state and account totals",
			"  use <provider> <alias>       Serve this provider with that credential",
			"  import                       Re-read the credentials OpenCode holds",
			"  on | off                     Toggle automatic failover",
			"  priority                     Credential order, with each one's switches",
			"  chain <model>                Targets for a row, in the order they are tried",
			"  chain <model> add <provider> <model>",
			"  chain <model> remove|up|down <provider>",
			"  chain <model> reset          Hand the row back to the credential order",
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
		const account = getAccount(db, providerID, alias);
		if (!account) return `No credential ${providerID}/${alias}.`;
		// Picking a credential is how its provider is told to serve with it: the
		// row moves ahead of that provider's others, which is what routing reads.
		useAccount(db, providerID, alias);
		// Choosing an account is the retry a park was waiting for.
		clearAccountPark(db, account.providerID, account.alias);
		return `${providerID}/${account.alias} serves ${providerID} now.`;
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
		const entries = orderedAccounts(db);
		if (entries.length === 0) return "No providers saved.";
		return entries
			.map(
				(account, index) =>
					`${index + 1}. ${account.providerID}/${account.alias}  ${
						account.disabled ? "off" : "on"
					}${account.freeOnly ? "  free-only" : ""}`,
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
		const [token, toggle] = args;
		if (!token || (toggle !== "on" && toggle !== "off")) {
			return "Usage: /balancer free <credential> on | off";
		}
		const targets = namedAccounts(db, token);
		if (targets.length === 0) return `No credential matches "${token}".`;
		for (const account of targets) {
			setAccountFreeOnly(
				db,
				account.providerID,
				account.alias,
				toggle === "on",
			);
		}
		invalidateCatalog();
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
			setAccountEnabled(
				db,
				account.providerID,
				account.alias,
				action === "enable",
			);
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
		moveAccount(
			db,
			account.providerID,
			account.alias,
			action === "up" ? -1 : 1,
		);
		return `Moved ${account.providerID}/${account.alias} ${action}.`;
	}

	return `Unknown command: ${action}. Use /balancer help.`;
}
