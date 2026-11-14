import type { Database } from "bun:sqlite";
import { listAccounts, orderedAccounts, syncActiveAlias } from "./accounts";

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
 * Write the order `provider_priority` held onto the credentials themselves.
 *
 * Rebuilding the table for the two new columns left every credential at zero,
 * so without this the order the user had would collapse into an alphabetical
 * one. The old order is reproduced faithfully: providers in the order
 * `listProviderPriority` used to report — stored rows by position, everything
 * else alphabetical after them — and each provider's credentials kept together
 * in their own order, exactly the sequence an automatic row used to route in.
 *
 * Only an order-less table is seeded. Positions that are already real are the
 * user's, written by `↑ ↓`, and must never be resorted on a later boot.
 *
 * Writing the order is only half of it: `active_alias` is what the panel calls
 * `active`, so leaving it where it was would put the marker on a credential the
 * provider would no longer serve with — the exact "why is that row marked and
 * the other one not" the order is meant to answer.
 */
function seedCredentialOrder(db: Database) {
	const accounts = listAccounts(db);
	if (accounts.length < 2) return;
	if (accounts.some((account) => account.position !== 0)) return;

	const stored = new Map(
		db
			.query<{ position: number; provider_id: string }, []>(
				"SELECT provider_id, position FROM provider_priority",
			)
			.all()
			.map((row) => [row.provider_id, row.position]),
	);

	const providers = [...new Set(accounts.map((account) => account.providerID))];
	providers.sort((a, b) => {
		const left = stored.get(a);
		const right = stored.get(b);
		if (left !== undefined && right !== undefined) {
			return left - right || a.localeCompare(b);
		}
		if (left !== undefined) return -1;
		if (right !== undefined) return 1;
		return a.localeCompare(b);
	});

	const write = db.transaction(() => {
		let position = 0;
		for (const providerID of providers) {
			for (const account of orderedAccounts(db, providerID)) {
				db.query<unknown, [number, string, string]>(
					`UPDATE accounts SET position = ?
                     WHERE provider_id = ? AND alias = ?`,
				).run(position, account.providerID, account.alias);
				position += 1;
			}
		}
		// The marker follows the order, so the two never disagree on screen.
		syncActiveAlias(db, providers);
	});
	write();
}

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

	// The order has to be read before the table that holds it is emptied.
	seedCredentialOrder(db);
	// Positions come from the credentials now, so nothing is left to read here.
	db.query<unknown, []>("DELETE FROM provider_priority").run();
}
