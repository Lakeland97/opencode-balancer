import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	clearAccountPark,
	getAccount,
	moveAccount,
	orderedAccounts,
	setAccountEnabled,
	setAccountFreeOnly,
	useAccount,
} from "../core/accounts";
import {
	addTarget,
	createChain,
	removeTarget,
	resetRow,
	rowByKey,
	shiftTarget,
	shiftTargetTo,
} from "./chain-actions";
import { invalidateCatalog } from "./connectors";
import { forgetRoutingMemory } from "./hooks";
import { recordLog } from "./log";
import type { WriteResult } from "./settings";

type Pair = { providerID: string; alias: string };
/** A chain target is named by its provider alone; a credential pair is not its key. */
type TargetRef = { providerID: string };

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

/**
 * Chain writes shared by the panel and the command parser. A chain edit changes
 * which provider serves, so a successful one drops the routing memory exactly
 * as the panel's own call does.
 */
export async function writeChainAdd(
	ctx: Context,
	db: Database,
	input: TargetRef & { key: string; modelID: string },
): Promise<WriteResult> {
	const { key, providerID, modelID } = input;
	const family = await rowByKey(ctx, db, key);
	if (!family) return { message: `No row named ${key}.`, ok: false };
	const result = await addTarget(ctx, db, family, providerID, modelID);
	if (result.ok) forgetRoutingMemory();
	return result;
}

export async function writeChainCreate(
	ctx: Context,
	db: Database,
	input: TargetRef & { modelID: string },
): Promise<WriteResult & { key: string }> {
	const result = await createChain(ctx, db, input.providerID, input.modelID);
	if (result.ok) forgetRoutingMemory();
	// The caller needs the row's key to address it next; a refusal has none.
	return { ...result, key: result.key ?? "" };
}

export async function writeChainMove(
	ctx: Context,
	db: Database,
	input: TargetRef & { key: string; direction?: "up" | "down"; to?: number },
): Promise<WriteResult> {
	const { key, providerID, to, direction } = input;
	const family = await rowByKey(ctx, db, key);
	if (!family) return { message: `No row named ${key}.`, ok: false };
	// A drag names the slot it landed on; the step controls name a direction.
	const result =
		typeof to === "number"
			? shiftTargetTo(db, family, providerID, to)
			: shiftTarget(db, family, providerID, direction ?? "down");
	if (result.ok) forgetRoutingMemory();
	return result;
}

export async function writeChainRemove(
	ctx: Context,
	db: Database,
	input: TargetRef & { key: string },
): Promise<WriteResult> {
	const { key, providerID } = input;
	const family = await rowByKey(ctx, db, key);
	if (!family) return { message: `No row named ${key}.`, ok: false };
	const result = removeTarget(db, family, providerID);
	if (result.ok) forgetRoutingMemory();
	return result;
}

export async function writeChainReset(
	ctx: Context,
	db: Database,
	key: string,
): Promise<WriteResult> {
	const family = await rowByKey(ctx, db, key);
	if (!family) return { message: `No row named ${key}.`, ok: false };
	const existed = resetRow(db, family);
	if (existed) forgetRoutingMemory();
	return {
		message: existed
			? `${key} is back to automatic order.`
			: `${key} was already automatic.`,
		ok: true,
	};
}
