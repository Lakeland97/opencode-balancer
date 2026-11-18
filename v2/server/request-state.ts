import type { Database } from "bun:sqlite";
import {
	clearLimitedUntil,
	getAccount,
	setLimitedReason,
	setLimitedUntil,
} from "../core/accounts";
import { parseRollover } from "../core/rollover";
import { now } from "../core/time";

/**
 * Statuses that mean "this account cannot serve right now". Billing and auth
 * failures qualify: a credential with no credit is as unusable as a limited
 * one, and leaving it in place makes balancing look broken.
 */
export const RETRYABLE_STATUS = new Set([
	401, 402, 403, 408, 409, 429, 500, 502, 503, 504, 529,
]);

/**
 * A failure the conversation itself caused, which no other account would accept
 * either: the request has outgrown the window and must be compacted. Parking a
 * provider on one of these would take a healthy account out of rotation for a
 * request-shaped problem, so they are recognised before anything else.
 */
const OVERFLOW_TEXT =
	/prompt is too long|input is too long|context window|context length|maximum context|maximum (?:prompt|input) length|max (?:prompt|input) length|too many tokens|token limit exceeded|reduce the length of the messages|request_too_large|request entity too large|payload too large|exceeds the limit of/i;

/**
 * A failure the provider refuses on principle. Every account would refuse it, so
 * the message belongs in front of the user rather than behind a failover.
 */
const REFUSAL_TEXT =
	/content[-_\s]?(?:filter\w*|polic\w*|moderation\w*)|usage polic\w*|safety system|moderation_blocked/i;

/** A failure the user caused by stopping the turn, which must park nobody. */
const ABORT_TEXT =
	/aborted by the user|user (?:abort|interrupt|cancel)|request (?:was )?cancel?led|operation was aborted/i;

/**
 * A stream the host or network cut for taking too long. The host sometimes
 * words this as an abort ("The operation was aborted due to timeout"), so it is
 * checked before the user-abort pattern: a model that is merely slow is the
 * account's availability, and another target may answer it.
 */
const TIMEOUT_TEXT = /timed?\s*out|timeout|deadline exceeded|etimedout/i;

/** A failure that names the request or the model as unusable anywhere. */
const INVALID_REQUEST_TEXT =
	/model_not_found|model unavailable|model not found|invalid[-_ ]?request|invalid prompt|validation ?exception|unsupported (?:model|operation|parameter)|does not support|no such model/i;

/**
 * What a provider says when it has stopped serving this account. The host turns
 * several of these into a typed error with no HTTP status at all — OpenCode Go's
 * "monthly usage limit reached" and "Insufficient balance" are the ones that
 * bite — so the words are matched as well as the status. This list is a head
 * start, not the whole test: the default in `isRetryableFailure` carries the rest.
 */
const RETRYABLE_TEXT =
	/quota|insufficient|no credit|out of credit|credit limit|balance|billing|payment|budget|allowance|spend|usage limit|limit reached|limit exceeded|limit exhausted|extra usage|exhausted|free messages|daily limit|resets at|unauthori[sz]ed|authentication|invalid api key|permission|forbidden|rate.?limit|too many requests|throttl|overloaded|capacity|temporarily unavailable|service[-_\s]?unavailable|server error|internal error/i;

/**
 * The reason tags the host attaches to a failure another target may survive.
 * Matched against the error's own name, `type` and `_tag`, which the host fills
 * from its provider-error classification. Deliberately absent: `InvalidRequest`,
 * `ContentPolicy`, `UnsupportedOperation` and `NoRoute`, which another account
 * would refuse in the same words.
 */
const RETRYABLE_TAG =
	/quota|rate.?limit|authentication|providerinternal|unknownprovider|transport|timeout/i;

/** Everything the error says about itself, as one haystack. */
function errorText(error: unknown): string {
	if (!error || typeof error !== "object") return "";
	const value = error as {
		message?: unknown;
		name?: unknown;
		response?: { body?: unknown };
		type?: unknown;
		_tag?: unknown;
	};
	return [
		value.name,
		value.type,
		value._tag,
		value.message,
		value.response?.body,
	]
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join(" ");
}

/**
 * Whether a failed attempt should park its account and fail over.
 *
 * The lists above are a head start, not the test. A provider invents a new way
 * to say "this account is spent" every few months — OpenCode Go's "You've used
 * today's free messages. They reset at 11:27 AM." is the wording that broke the
 * keyword-only version — so anything unrecognised arriving without a status is
 * presumed transient. The host's own retry policy reasons the same way: a
 * deterministic rejection almost always carries a status or a code, while a
 * transient failure arrives in whatever wording it likes.
 *
 * Guessing "transient" is the cheap error here. A park is bounded and any `use`
 * clears it, whereas guessing "permanent" hands the failure to the session,
 * which is exactly the cut-off this must prevent.
 */
export function isRetryableFailure(input: {
	status?: number;
	error?: unknown;
}): boolean {
	const text = errorText(input.error);

	// What the conversation caused, and what another account would refuse in the
	// same words: neither is this account's fault.
	if (OVERFLOW_TEXT.test(text) || REFUSAL_TEXT.test(text)) return false;
	// A slow provider is an availability problem, even when the host describes
	// the cut stream as an abort. Checked before ABORT_TEXT so a timeout that
	// borrows that wording still fails over.
	if (TIMEOUT_TEXT.test(text)) return true;
	if (ABORT_TEXT.test(text) || INVALID_REQUEST_TEXT.test(text)) return false;

	// What this account's own state says: spent, unauthenticated, throttled.
	if (RETRYABLE_TAG.test(text) || RETRYABLE_TEXT.test(text)) return true;

	const status = input.status;
	if (typeof status === "number") {
		if (RETRYABLE_STATUS.has(status) || status >= 500) return true;
		// Any other status is a plain rejection of this one request.
		return false;
	}

	// No status, nothing recognised: presumed transient, as above.
	return text !== "";
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
 * How long the provider itself asked to wait, when the host raised a typed error
 * instead of a response. `SessionError.Error` carries this field, and ignoring
 * it parked a quota failure for the default minute regardless of the window the
 * endpoint had actually named.
 */
export function errorRetryAfterMs(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	return undefined;
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
	reason?: string,
) {
	const account = getAccount(db, providerID, alias);
	if (!account) return;

	const timestamp = now();
	if (reason) {
		setLimitedReason(db, providerID, alias, reason);
		// The instant is read from the whole message, before the reason is cut
		// down to what a tooltip can hold, and replaced with whatever this
		// failure said: a later park that names nothing must not inherit the
		// previous one's time.
		clearLimitedUntil(db, providerID, alias);
		const until = parseRollover(reason, timestamp);
		if (until !== undefined) {
			setLimitedUntil(db, providerID, alias, until);
		}
	}
	if (account.rateLimitedUntil && account.rateLimitedUntil > timestamp) return;

	db.query<unknown, [number, number, string, string]>(
		`UPDATE accounts
         SET failures = failures + 1,
             rate_limited_until = ?,
             updated_at = ?
         WHERE provider_id = ? AND alias = ?`,
	).run(timestamp + durationMs, timestamp, providerID, account.alias);
}
