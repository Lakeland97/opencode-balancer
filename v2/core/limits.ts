import type { Database } from "bun:sqlite";

const rowLimitKey = (familyKey: string) => `row_limit:${familyKey}`;
const targetLimitKey = (familyKey: string, providerID: string) =>
	`target_limit:${familyKey}:${providerID}`;

/**
 * Reads a token ceiling, treating anything a setter would have cleared as
 * absent. A malformed row must read as "no limit", not as a NaN limit that
 * would clamp every window down to nothing.
 */
function readLimit(db: Database, key: string): number | undefined {
	const value = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(key)?.value;
	if (value === undefined) return undefined;
	const tokens = Number(value);
	return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

function writeLimit(
	db: Database,
	key: string,
	tokens: number | undefined,
): void {
	if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(key);
		return;
	}
	db.query<unknown, [string, string]>(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(key, String(tokens));
}

/** The token ceiling the user set on a whole row, or undefined when unset. */
export function readRowLimit(
	db: Database,
	familyKey: string,
): number | undefined {
	return readLimit(db, rowLimitKey(familyKey));
}

/** Setting a limit of undefined or at most zero removes it. */
export function setRowLimit(
	db: Database,
	familyKey: string,
	tokens: number | undefined,
): void {
	writeLimit(db, rowLimitKey(familyKey), tokens);
}

/** The token ceiling the user set on one target of a row, or undefined. */
export function readTargetLimit(
	db: Database,
	familyKey: string,
	providerID: string,
): number | undefined {
	return readLimit(db, targetLimitKey(familyKey, providerID));
}

/** Setting a limit of undefined or at most zero removes it. */
export function setTargetLimit(
	db: Database,
	familyKey: string,
	providerID: string,
	tokens: number | undefined,
): void {
	writeLimit(db, targetLimitKey(familyKey, providerID), tokens);
}
