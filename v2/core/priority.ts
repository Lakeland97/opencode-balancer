import type { Database } from "bun:sqlite";
import { orderedAccounts } from "./accounts";

/**
 * Which provider comes first, derived from the credentials the router walks.
 *
 * A credential is the unit of order — the panel lists one row per credential and
 * `↑ ↓` moves that row — so a provider's place is simply where its earliest
 * credential sits. The stored `provider_priority` table this used to read is not
 * consulted any more; `migrateProviderSettings` empties it.
 */
export function providerOrder(db: Database): Map<string, number> {
	const order = new Map<string, number>();
	for (const account of orderedAccounts(db)) {
		if (!order.has(account.providerID))
			order.set(account.providerID, order.size);
	}
	return order;
}

export function getBalancingEnabled(db: Database): boolean {
	const row = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get("balancing_enabled");

	return row?.value === "1";
}

export function setBalancingEnabled(db: Database, enabled: boolean) {
	db.query<unknown, [string]>(
		`INSERT INTO settings (key, value) VALUES ('balancing_enabled', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(enabled ? "1" : "0");
}

const freeOnlyPrefix = "free_only:";

/**
 * Move the switches that used to belong to a provider onto its credentials.
 *
 * This fork once kept `free models only` as a setting per provider and the
 * on/off switch as a row in `provider_priority`. Both are per credential now, so
 * this copies each provider-level answer onto the credentials it applied to and
 * then forgets it. Running it on every boot is harmless: the settings are gone
 * after the first pass, so a credential added later is not dragged back to a
 * choice the user made about the provider rather than about it.
 */
export function migrateProviderSettings(db: Database) {
	const freeSettings = db
		.query<{ key: string; value: string }, []>(
			`SELECT key, value FROM settings WHERE key LIKE '${freeOnlyPrefix}%'`,
		)
		.all();
	for (const row of freeSettings) {
		if (row.value === "1") {
			db.query<unknown, [string]>(
				"UPDATE accounts SET free_only = 1 WHERE provider_id = ?",
			).run(row.key.slice(freeOnlyPrefix.length));
		}
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(
			row.key,
		);
	}

	const switchedOff = db
		.query<{ provider_id: string }, []>(
			"SELECT provider_id FROM provider_priority WHERE enabled = 0",
		)
		.all();
	for (const row of switchedOff) {
		db.query<unknown, [string]>(
			"UPDATE accounts SET disabled = 1 WHERE provider_id = ?",
		).run(row.provider_id);
	}
	// Positions come from the credentials now, so nothing is left to read here.
	db.query<unknown, []>("DELETE FROM provider_priority").run();
}
