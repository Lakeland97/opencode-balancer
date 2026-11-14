import type { Database } from "bun:sqlite";
import { getAccount } from "../core/accounts";
import { now } from "../core/time";

/**
 * Statuses that mean "this account cannot serve right now". Billing and auth
 * failures qualify: a credential with no credit is as unusable as a limited
 * one, and leaving it in place makes balancing look broken.
 */
export const RETRYABLE_STATUS = new Set([
	401, 402, 403, 429, 500, 502, 503, 504, 529,
]);

/** Fallback match for failures the host raises without an HTTP status. */
const RETRYABLE_TEXT =
	/quota|insufficient|no credit|out of credit|balance|unauthori[sz]ed|rate.?limit|too many requests|overloaded|capacity/i;

/**
 * Whether a failed attempt should park its account and fail over. The host
 * sometimes turns a provider error into a typed error with no status, so the
 * error's own name and message are consulted as well.
 */
export function isRetryableFailure(input: {
	status?: number;
	error?: unknown;
}): boolean {
	const status = input.status;
	if (typeof status === "number") {
		if (RETRYABLE_STATUS.has(status) || status >= 500) return true;
	}
	const error = input.error as
		| { message?: unknown; name?: unknown; type?: unknown; _tag?: unknown }
		| undefined;
	if (!error || typeof error !== "object") return false;
	const text = [error.name, error.type, error._tag, error.message]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	return text.length > 0 && RETRYABLE_TEXT.test(text);
}

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
