import type { Database } from "bun:sqlite";
import { getActiveAccount, listAccounts } from "../core/accounts";
import { now } from "../core/time";
import type { Account } from "../core/types";

export function isHealthy(account: Account, at: number = now()) {
	if (account.disabled) return false;
	return !account.rateLimitedUntil || account.rateLimitedUntil <= at;
}

/**
 * Pick the account to authorise the next request with.
 *
 * Prefers the provider's stored active account so normal operation stays
 * stable, and only falls back to another account when the active one is
 * disabled or currently rate limited.
 */
export function selectHealthyAccount(
	db: Database,
	providerID: string,
): Account | undefined {
	const healthy = listAccounts(db, providerID).filter((account) =>
		isHealthy(account),
	);
	if (healthy.length === 0) return undefined;

	const active = getActiveAccount(db, providerID);
	if (active && isHealthy(active)) return active;
	return healthy[0];
}

export function hasAlternativeAccount(
	db: Database,
	providerID: string,
	excludeAlias: string,
) {
	return listAccounts(db, providerID).some(
		(account) => account.alias !== excludeAlias && isHealthy(account),
	);
}
