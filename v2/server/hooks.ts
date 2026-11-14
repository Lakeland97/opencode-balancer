import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import { getActiveAccount } from "../core/accounts";
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
import {
	markRateLimited,
	RETRYABLE_STATUS,
	retryAfterMs,
} from "./request-state";
import {
	chooseRoute,
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
		const route = chooseRoute(db, family);
		if (!route) return;

		event.baseURL = route.baseURL;
		const headers = new Headers(event.headers);
		applyAuthToHeaders(headers, route.account.auth);
		event.headers = Object.fromEntries(headers);

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

			const remembered = bySession.get(sessionKey(event.sessionID, ROUTED));
			const ordered = resolveChain(db, family);
			const pinned = remembered
				? ordered.filter((route) => route.providerID === remembered.providerID)
				: [];
			// Without automatic compaction nothing trims the conversation, so a
			// target that cannot hold it is skipped rather than sent the request.
			const guardOverflow = !getCompactionAutoEnabled();
			const body = guardOverflow
				? await event.request.clone().text()
				: undefined;
			const route =
				chooseRouteForRequest(
					db,
					{ ...family, stored: true, targets: pinned },
					body,
					{ guardOverflow },
				) ?? chooseRouteForRequest(db, family, body, { guardOverflow });
			if (!route) return;

			let request = event.request;
			const url = routedURL(request.url, route.baseURL);
			if (url && url !== request.url) request = new Request(url, request);
			request = await rewriteModel(request, route.modelID);

			const headers = new Headers(request.headers);
			applyAuthToHeaders(headers, route.account.auth);
			request = new Request(request, { headers });

			event.request = request;
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

		const tracked = { alias: account.alias, at: now(), providerID };
		byRequest.set(event.request, tracked);
		bySession.set(sessionKey(event.sessionID, providerID), tracked);
	});

	await ctx.session.hook("http.response", (event) => {
		if (!RETRYABLE_STATUS.has(event.response.status)) return;
		const tracked = lookupTracked({
			providerID: event.model.providerID,
			request: event.request,
			sessionID: event.sessionID,
		});
		if (!tracked) return;
		markRateLimited(
			db,
			tracked.providerID,
			tracked.alias,
			retryAfterMs(event.response),
		);
	});

	await ctx.session.hook("retry", async (event) => {
		const status = (event.error as { status?: number }).status;
		if (!status || !RETRYABLE_STATUS.has(status)) return;

		const tracked = lookupTracked({
			providerID: event.model.providerID,
			sessionID: event.sessionID,
		});
		if (!tracked) return;

		markRateLimited(db, tracked.providerID, tracked.alias);

		if (!getBalancingEnabled(db)) return;

		const routed = event.model.providerID === BALANCER_PROVIDER_ID;
		const family = routed
			? await familyFor(ctx, db, event.model.id)
			: undefined;
		const canContinue = routed
			? Boolean(family && hasAlternativeRoute(db, family, tracked.providerID))
			: hasAlternativeAccount(db, tracked.providerID, tracked.alias);
		if (!canContinue) return;

		// Forget the call's target so the retry routes from scratch; the account
		// just marked limited is skipped by the health check.
		bySession.delete(sessionKey(event.sessionID, ROUTED));
		bySession.delete(sessionKey(event.sessionID, tracked.providerID));

		event.decision = { delay: 0, retry: true };
	});
}
