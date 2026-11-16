import type { Database } from "bun:sqlite";
import {
	clearAccountPark,
	getAccount,
	moveAccount,
	orderedAccounts,
	setAccountEnabled,
	setAccountFreeOnly,
	useAccount,
} from "../core/accounts";
import { invalidateCatalog } from "./connectors";
import { forgetRoutingMemory } from "./hooks";
import { recordLog } from "./log";
import type { WriteResult } from "./settings";

type Pair = { providerID: string; alias: string };

/**
 * Account writes shared by the RPC handlers and the command parser. The side
 * effects are the point: a command that disables a credential has to drop the
 * same routing memory and write the same config line as the panel's switch.
 */
export function writeSetEnabled(
	db: Database,
	input: Pair & { enabled: boolean },
): WriteResult {
	const { providerID, alias, enabled } = input;
	setAccountEnabled(db, providerID, alias, enabled);
	forgetRoutingMemory();
	recordLog(
		"config",
		`${providerID}/${alias} ${enabled ? "enabled" : "disabled"}`,
	);
	return {
		message: `${providerID}/${alias} ${enabled ? "enabled" : "disabled"}.`,
		ok: true,
	};
}

export function writeSetFreeOnly(
	db: Database,
	input: Pair & { enabled: boolean },
): WriteResult {
	const { providerID, alias, enabled } = input;
	setAccountFreeOnly(db, providerID, alias, enabled);
	// Which models a credential may serve just changed, so a catalogue built
	// under the old rule is stale.
	invalidateCatalog();
	forgetRoutingMemory();
	recordLog(
		"config",
		`${providerID}/${alias} ${enabled ? "free models only" : "paid models too"}`,
	);
	return {
		message: `${providerID}/${alias} uses ${enabled ? "free models only" : "paid models too"}.`,
		ok: true,
	};
}

export function writeUse(db: Database, input: Pair): WriteResult {
	const { providerID, alias } = input;
	const account = getAccount(db, providerID, alias);
	if (!account) {
		return { message: `No credential ${providerID}/${alias}.`, ok: false };
	}
	// Picking a credential is how its provider is told to serve with it: the row
	// moves ahead of that provider's other credentials, and the stored alias
	// names it. Routing reads the order, so the two agree.
	useAccount(db, providerID, alias);
	// It is also the retry a park was waiting for, so a parked credential becomes
	// eligible again and the next call actually goes there.
	clearAccountPark(db, account.providerID, account.alias);
	// The pick takes effect now, not after this session's next answer: the trail
	// and the pin are dropped so the next request derives its route from the
	// order the pick just changed. The window restarts by construction — the new
	// trail begins at the current time.
	forgetRoutingMemory();
	recordLog("config", `serving with ${providerID}/${account.alias}`);
	return {
		message: `Serving with ${providerID}/${account.alias}.`,
		ok: true,
	};
}

export function writeMove(
	db: Database,
	input: Pair & { direction?: "up" | "down"; to?: number },
): WriteResult {
	const { providerID, alias, to, direction } = input;
	// A drag names the slot it landed on; the step controls name a direction.
	if (typeof to === "number") {
		const all = orderedAccounts(db);
		const from = all.findIndex(
			(account) => account.providerID === providerID && account.alias === alias,
		);
		if (from === -1) {
			return {
				message: `No credential ${providerID}/${alias}.`,
				ok: false,
			};
		}
		const delta = Math.max(0, Math.min(to, all.length - 1)) - from;
		if (delta !== 0) moveAccount(db, providerID, alias, delta);
	} else {
		moveAccount(db, providerID, alias, direction === "up" ? -1 : 1);
	}
	forgetRoutingMemory();
	return {
		message:
			typeof to === "number"
				? `Moved ${providerID}/${alias}.`
				: `Moved ${providerID}/${alias} ${direction}.`,
		ok: true,
	};
}
