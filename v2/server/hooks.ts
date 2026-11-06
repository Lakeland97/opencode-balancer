import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin";
import { getActiveAccount } from "../core/accounts";
import { getBalancingEnabled } from "../core/priority";
import { now } from "../core/time";
import { applyAuthToHeaders } from "./apply-auth";
import { markRateLimited, RETRYABLE_STATUS, retryAfterMs } from "./request-state";
import { hasAlternativeAccount, selectHealthyAccount } from "./selection";

type Tracked = { providerID: string; alias: string; at: number };

// The response hook receives the same Request instance the request hook saw.
// Keep a per-session fallback too, in case opencode hands over a clone.
const byRequest = new WeakMap<Request, Tracked>();
const bySession = new Map<string, Tracked>();

const STALE_AFTER_MS = 5 * 60_000;

function sessionKey(sessionID: string, providerID: string) {
	return `${sessionID}:${providerID}`;
}

function track(sessionID: string, tracked: Tracked) {
	bySession.set(sessionKey(sessionID, tracked.providerID), tracked);
}

function lookupBySession(
	sessionID: string,
	providerID: string,
): Tracked | undefined {
	const tracked = bySession.get(sessionKey(sessionID, providerID));
	if (!tracked) return undefined;
	// A stale slot must not charge a failure to an account that is no longer
	// in use for this session.
	if (now() - tracked.at > STALE_AFTER_MS) return undefined;
	return tracked;
}

export async function registerHooks({
	ctx,
	db,
}: {
	ctx: Context;
	db: Database;
}) {
	await ctx.session.hook("http.request", (event) => {
		const providerID = event.model.providerID;
		const account = selectHealthyAccount(db, providerID);
		if (!account) return;

		// Normal operation keeps opencode's own (possibly refreshed) credential.
		// Only a failover onto a different saved account injects ours.
		const active = getActiveAccount(db, providerID);
		const isFailover = !active || active.alias !== account.alias;

		applyAuthToHeaders(event.request.headers, account.auth, {
			preserveExistingOAuth: !isFailover,
		});

		const tracked = { providerID, alias: account.alias, at: now() };
		byRequest.set(event.request, tracked);
		track(event.sessionID, tracked);
	});

	await ctx.session.hook("http.response", (event) => {
		if (!RETRYABLE_STATUS.has(event.response.status)) return;
		const tracked =
			byRequest.get(event.request) ??
			lookupBySession(event.sessionID, event.model.providerID);
		if (!tracked) return;
		markRateLimited(
			db,
			tracked.providerID,
			tracked.alias,
			retryAfterMs(event.response),
		);
	});

	await ctx.session.hook("retry", (event) => {
		const status = (event.error as { status?: number }).status;
		if (!status || !RETRYABLE_STATUS.has(status)) return;

		const tracked = lookupBySession(event.sessionID, event.model.providerID);
		if (!tracked) return;

		markRateLimited(db, tracked.providerID, tracked.alias);

		if (!getBalancingEnabled(db)) return;
		if (!hasAlternativeAccount(db, tracked.providerID, tracked.alias)) return;

		event.decision = { retry: true, delay: 0 };
	});
}
