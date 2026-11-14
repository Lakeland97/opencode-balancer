import type { Database } from "bun:sqlite";
import { orderedAccounts } from "../core/accounts";
import { now } from "../core/time";
import type { Account } from "../core/types";

export function isHealthy(account: Account, at: number = now()) {
	if (account.disabled) return false;
	return !account.rateLimitedUntil || account.rateLimitedUntil <= at;
}

/**
 * The credentials of one provider that may serve, in the balancer's order.
 *
 * The order is the whole answer: it is what the panel's `↑ ↓` edits and what
 * `use` writes, so the first healthy credential here is the one the provider
 * would serve with. There is no separate "active" preference to weigh against
 * it — the stored active alias follows this order rather than competing.
 */
export function healthyAccounts(db: Database, providerID: string): Account[] {
	return orderedAccounts(db, providerID).filter((account) =>
		isHealthy(account),
	);
}

export function selectHealthyAccount(
	db: Database,
	providerID: string,
): Account | undefined {
	return healthyAccounts(db, providerID)[0];
}

/**
 * The credentials of one provider that are switched on, in the balancer's order.
 *
 * A park is deliberately *not* filtered out. It is temporary and the row's own
 * marker already says when a credential is sitting one out, while what a row
 * says it is set up to send must not flicker as credentials are parked and
 * unparked — a row that cannot say "this one sends the free model" while its key
 * is parked is a row that has stopped saying it at all.
 */
export function enabledAccounts(db: Database, providerID: string): Account[] {
	return orderedAccounts(db, providerID).filter((account) => !account.disabled);
}

/**
 * Every healthy credential, in the balancer's order, whichever provider it is.
 *
 * This is the order an automatic row routes in: with no chain of its own, the
 * list the panel shows is the order the router walks, so the `↑ ↓` on a row
 * decides exactly where that row sits and lifting a credential above another
 * provider's moves it above that provider.
 */
export function healthyAccountsInOrder(db: Database): Account[] {
	return orderedAccounts(db).filter((account) => isHealthy(account));
}

export function hasAlternativeAccount(
	db: Database,
	providerID: string,
	excludeAlias: string,
) {
	return healthyAccounts(db, providerID).some(
		(account) => account.alias !== excludeAlias,
	);
}
