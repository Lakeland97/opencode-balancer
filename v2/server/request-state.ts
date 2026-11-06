import type { Database } from "bun:sqlite";
import { getAccount } from "../core/accounts";
import { now } from "../core/time";

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export function retryAfterMs(response: Response) {
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return 60_000;

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1000);

	const date = Date.parse(retryAfter);
	if (Number.isFinite(date)) return Math.max(1_000, date - Date.now());

	return 60_000;
}

/**
 * Park an account so request selection skips it until the window expires.
 * Calling this twice for the same failure must not extend the window, because
 * both the response hook and the retry hook observe the same failed attempt.
 */
export function markRateLimited(
	db: Database,
	providerID: string,
	alias: string,
	durationMs = 60_000,
) {
	const account = getAccount(db, providerID, alias);
	if (!account) return;

	const timestamp = now();
	if (account.rateLimitedUntil && account.rateLimitedUntil > timestamp) return;

	db.query<unknown, [number, number, string, string]>(
		`UPDATE accounts
         SET failures = failures + 1,
             rate_limited_until = ?,
             updated_at = ?
         WHERE provider_id = ? AND alias = ?`,
	).run(timestamp + durationMs, timestamp, providerID, account.alias);
}
