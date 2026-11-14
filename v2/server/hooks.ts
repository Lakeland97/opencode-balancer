import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import { getActiveAccount, markAccountUsed } from "../core/accounts";
import { getBalancingEnabled } from "../core/priority";
import { now } from "../core/time";
import { applyAuthToHeaders } from "./apply-auth";
import { getCompactionAutoEnabled } from "./compaction-config";
import {
	BALANCER_PROVIDER_ID,
	loadCatalog,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import { recordLog } from "./log";
import {
	isRetryableFailure,
	markRateLimited,
	retryAfterMs,
} from "./request-state";
import {
	chooseRouteForRequest,
	hasAlternativeRoute,
	rewriteModel,
	routedURL,
} from "./routing";
import { hasAlternativeAccount, selectHealthyAccount } from "./selection";

type Tracked = { providerID: string; alias: string; at: number };

// The response hook receives the same Request instance the request hook saw.
// Keep a per-session fallback too, in case opencode hands over a clone.
const byRequest = new WeakMap<Request, Tracked>();
const bySession = new Map<string, Tracked>();

const STALE_AFTER_MS = 5 * 60_000;
// The virtual provider's slot is keyed by `balancer`, which is the provider id
// `http.response` and `retry` report for a routed call.
const ROUTED = BALANCER_PROVIDER_ID;

function sessionKey(sessionID: string, providerID: string) {
	return `${sessionID}:${providerID}`;
}

function track(sessionID: string, tracked: Tracked) {
	bySession.set(sessionKey(sessionID, tracked.providerID), tracked);
	bySession.set(sessionKey(sessionID, ROUTED), tracked);
}

function fresh(tracked: Tracked) {
	return now() - tracked.at <= STALE_AFTER_MS;
}

// Providers this session has already tried since its last answer. A retry
// reads this so it moves forward through the chain instead of starting again
// at the first target and parking every provider on the way down.
const triedBySession = new Map<string, Set<string>>();

function triedFor(sessionID: string) {
	let tried = triedBySession.get(sessionID);
	if (!tried) {
		tried = new Set();
		triedBySession.set(sessionID, tried);
	}
	return tried;
}

/**
 * One route choice for both request hooks. The session keeps the provider
 * that last answered while it is healthy, so a conversation stays on the model
 * it shifted to instead of snapping back to the top of the chain. Providers
 * already tried since the last answer are skipped; if that leaves nothing, the
 * chain wraps around to the head.
 */
function chooseStickyRoute(input: {
	db: Database;
	family: ModelFamily;
	sessionID: string;
	body?: string;
	guardOverflow: boolean;
}) {
	const { db, family, sessionID } = input;
	const tried = triedFor(sessionID);
	const remembered = bySession.get(sessionKey(sessionID, ROUTED));
	const pinned =
		remembered && fresh(remembered)
			? {
					...family,
					stored: true,
					targets: resolveChain(db, family).filter(
						(route) => route.providerID === remembered.providerID,
					),
				}
			: undefined;
	const options = { exclude: tried, guardOverflow: input.guardOverflow };

	return (
		(pinned
			? chooseRouteForRequest(db, pinned, input.body, options)
			: undefined) ??
		chooseRouteForRequest(db, family, input.body, options) ??
		// Everything has been tried since the last answer: wrap around.
		chooseRouteForRequest(db, family, input.body, {
			guardOverflow: input.guardOverflow,
		})
	);
}

function lookupTracked(input: {
	sessionID: string;
	providerID: string;
	request?: Request;
}): Tracked | undefined {
	if (input.request) {
		const direct = byRequest.get(input.request);
		if (direct) return direct;
	}
	const tracked = bySession.get(sessionKey(input.sessionID, input.providerID));
	// A stale slot must not charge a failure to an account that is no longer
	// in use for this session.
	return tracked && fresh(tracked) ? tracked : undefined;
}

async function familyFor(
	ctx: Context,
	db: Database,
	modelID: string,
): Promise<ModelFamily | undefined> {
	const catalog = await loadCatalog(ctx, db);
	return catalog.families.find((family) => family.key === modelID);
}

export async function registerHooks({
	ctx,
	db,
}: {
	ctx: Context;
	db: Database;
}) {
	// A routed call is pointed at its connector before the Request exists, so the
	// URL and credential are the connector's from the start.
	await ctx.session.hook("model.request", async (event) => {
		if (event.model.providerID !== BALANCER_PROVIDER_ID) return;
		const family = await familyFor(ctx, db, event.model.id);
		if (!family) return;
		// The same route the request hook will pick, so the URL and credential
		// set here cannot point at a different provider than the one it uses.
		const route = chooseStickyRoute({
			db,
			family,
			guardOverflow: false,
			sessionID: event.sessionID,
		});
		if (!route) return;

		event.baseURL = route.baseURL;
		const headers = new Headers(event.headers);
		applyAuthToHeaders(headers, route.account.auth);
		event.headers = Object.fromEntries(headers);

		markAccountUsed(db, route.providerID, route.account.alias);
		track(event.sessionID, {
			alias: route.account.alias,
			at: now(),
			providerID: route.providerID,
		});
	});

	await ctx.session.hook("http.request", async (event) => {
		const providerID = event.model.providerID;

		if (providerID === BALANCER_PROVIDER_ID) {
			// The model-request hook already retargeted the URL and credential;
			// this replaces the virtual family name with the connector's id and
			// covers the case where that hook did not run.
			const family = await familyFor(ctx, db, event.model.id);
			if (!family) return;

			// Without automatic compaction nothing trims the conversation, so a
			// target that cannot hold it is skipped rather than sent the request.
			// A row limit can also leave a smaller target unable to hold what the
			// row now permits, which needs the same skip.
			const guardOverflow =
				!getCompactionAutoEnabled() || Boolean(family.guardOverflow);
			const body = guardOverflow
				? await event.request.clone().text()
				: undefined;
			const route = chooseStickyRoute({
				body,
				db,
				family,
				guardOverflow,
				sessionID: event.sessionID,
			});
			if (!route) return;

			let request = event.request;
			const url = routedURL(request.url, route.baseURL);
			if (url && url !== request.url) request = new Request(url, request);
			request = await rewriteModel(request, route.modelID);

			const headers = new Headers(request.headers);
			applyAuthToHeaders(headers, route.account.auth);
			request = new Request(request, { headers });

			event.request = request;
			recordLog(
				"route",
				`${family.key} → ${route.providerID}/${route.account.alias} (${route.modelID})`,
			);
			markAccountUsed(db, route.providerID, route.account.alias);
			byRequest.set(request, {
				alias: route.account.alias,
				at: now(),
				providerID: route.providerID,
			});
			track(event.sessionID, {
				alias: route.account.alias,
				at: now(),
				providerID: route.providerID,
			});
			return;
		}

		const account = selectHealthyAccount(db, providerID);
		if (!account) return;

		// Normal operation keeps opencode's own (possibly refreshed) credential.
		// Only a failover onto a different saved account injects ours.
		const active = getActiveAccount(db, providerID);
		const isFailover = !active || active.alias !== account.alias;

		applyAuthToHeaders(event.request.headers, account.auth, {
			preserveExistingOAuth: !isFailover,
		});

		recordLog("route", `${providerID} → ${account.alias}`);
		markAccountUsed(db, account.providerID, account.alias);
		const tracked = { alias: account.alias, at: now(), providerID };
		byRequest.set(event.request, tracked);
		bySession.set(sessionKey(event.sessionID, providerID), tracked);
	});

	await ctx.session.hook("http.response", (event) => {
		const tracked = lookupTracked({
			providerID: event.model.providerID,
			request: event.request,
			sessionID: event.sessionID,
		});
		if (!tracked) return;
		if (!isRetryableFailure({ status: event.response.status })) {
			// An answer ends the failover trail: the session stays on this
			// target and a later failure may try the others again.
			triedBySession.delete(event.sessionID);
			return;
		}
		const reported = `HTTP ${event.response.status}${
			event.response.statusText ? ` ${event.response.statusText}` : ""
		}`;
		markRateLimited(
			db,
			tracked.providerID,
			tracked.alias,
			retryAfterMs(event.response),
			reported,
		);
		recordLog(
			"failover",
			`${tracked.providerID}/${tracked.alias} answered ${reported}; parked`,
		);
	});

	await ctx.session.hook("retry", async (event) => {
		const status = (event.error as { status?: number } | undefined)?.status;
		if (!isRetryableFailure({ error: event.error, status })) return;

		const tracked = lookupTracked({
			providerID: event.model.providerID,
			sessionID: event.sessionID,
		});
		if (!tracked) return;

		// The typed error the host raised carries the provider's own words, so
		// it is a better answer than the bare status the response already set.
		const reported = (
			event.error as { message?: string } | undefined
		)?.message?.trim();
		markRateLimited(
			db,
			tracked.providerID,
			tracked.alias,
			60_000,
			reported || undefined,
		);
		triedFor(event.sessionID).add(tracked.providerID);
		recordLog(
			"failover",
			`${tracked.providerID}/${tracked.alias} failed${
				reported ? `: ${reported.slice(0, 120)}` : ""
			}; moving to the next target`,
		);

		if (!getBalancingEnabled(db)) return;

		const routed = event.model.providerID === BALANCER_PROVIDER_ID;
		const family = routed
			? await familyFor(ctx, db, event.model.id)
			: undefined;
		const canContinue = routed
			? Boolean(family && hasAlternativeRoute(db, family, tracked.providerID))
			: hasAlternativeAccount(db, tracked.providerID, tracked.alias);
		if (!canContinue) {
			recordLog(
				"error",
				`no alternative to ${tracked.providerID}/${tracked.alias}; the session sees the error`,
			);
			return;
		}

		// Forget the call's target so the retry routes from scratch; the account
		// just marked limited is skipped by the health check.
		bySession.delete(sessionKey(event.sessionID, ROUTED));
		bySession.delete(sessionKey(event.sessionID, tracked.providerID));

		event.decision = { delay: 0, retry: true };
	});
}
