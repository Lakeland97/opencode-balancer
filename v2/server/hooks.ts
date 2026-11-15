import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	accountKey,
	getAccount,
	getActiveAccount,
	markAccountUsed,
} from "../core/accounts";
import { appendEvent } from "../core/events";
import { getBalancingEnabled } from "../core/priority";
import { rebalanceAfterMs } from "../core/rebalance";
import { now } from "../core/time";
import { applyAuthToHeaders } from "./apply-auth";
import {
	BALANCER_PROVIDER_ID,
	loadCatalog,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import { recordLog } from "./log";
import {
	errorRetryAfterMs,
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

type Tracked = {
	providerID: string;
	alias: string;
	at: number;
	/** The row the call routed, and the window the connector that took it holds. */
	familyKey?: string;
	context?: number;
};

// The response hook receives the same Request instance the request hook saw.
// Keep a per-session fallback too, in case opencode hands over a clone.
const byRequest = new WeakMap<Request, Tracked>();
const bySession = new Map<string, Tracked>();

const STALE_AFTER_MS = 5 * 60_000;
// The virtual provider's slot is keyed by `balancer`, which is the provider id
// `http.response` and `retry` report for a routed call.
const ROUTED = BALANCER_PROVIDER_ID;
// How many targets one session may try before the real failure is handed over.
// Comfortably longer than any chain, so it only fires after a wrap-around.
const ATTEMPT_CAP = 12;
// A provider that names its own window is believed, but only so far: a park is
// cleared by `use`, and a mis-parsed value must not sit on an account for days.
const MAX_PARK_MS = 60 * 60_000;

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

/** Whether an account is currently sitting out its cooldown. */
function isParked(db: Database, providerID: string, alias: string) {
	const account = getAccount(db, providerID, alias);
	return Boolean(account?.rateLimitedUntil && account.rateLimitedUntil > now());
}

// Credentials this session has already tried since its last answer, named
// `provider/alias`. A retry reads this so it moves forward through the chain
// instead of starting again at the first target and parking everything on the
// way down; naming the credential rather than the provider is what lets the
// second credential of a provider still answer.
//
// The trail carries its own clock because the routing slots cannot: the failover
// path clears those before a retry on purpose, so by the time the question is
// asked there is nothing there to date. `at` is refreshed by every routing
// decision, which makes it the last time this session was balanced.
type Trail = { at: number; tried: Set<string> };
const trailsBySession = new Map<string, Trail>();

function trailFor(sessionID: string) {
	let trail = trailsBySession.get(sessionID);
	if (!trail) {
		trail = { at: now(), tried: new Set() };
		trailsBySession.set(sessionID, trail);
	}
	return trail;
}

function triedFor(sessionID: string) {
	const trail = trailFor(sessionID);
	trail.at = now();
	return trail.tried;
}

// The target each session was last announced on, so a switch can name where it
// came from. Kept apart from the routing slots above, which the failover path
// deliberately clears before a retry: erasing that history would make every
// failover read as a fresh first choice.
const announced = new Map<string, { alias: string; providerID: string }>();

/**
 * Forget a trail that has outlived the idle window.
 *
 * Only the trail goes — a park is the provider's own clock and expires on its
 * own schedule, and throwing that away would send a call straight back to
 * something still limited.
 */
function forgetStaleTrail(db: Database, sessionID: string) {
	const trail = trailsBySession.get(sessionID);
	if (!trail) return;
	const window = rebalanceAfterMs(db);
	// Zero is the window switched off, so nothing ages a trail out but a change to
	// the order itself.
	if (window <= 0) return;
	if (now() - trail.at <= window) return;
	trailsBySession.delete(sessionID);
	announced.delete(sessionKey(sessionID, ROUTED));
}

/**
 * Start every session's balance over, because the order changed under it.
 *
 * Picking a credential, reordering one, or editing a chain changes what the order
 * means, and a session still walking the old one holds a trail and a pin that
 * describe a world that no longer exists. Dropping them makes the next request
 * re-derive its route from the order as it now stands, which is what lets a
 * picked credential actually serve instead of waiting behind the one this
 * session last answered on. The idle window restarts by construction: the next
 * trail is created with the current time.
 *
 * The per-provider slots stay. They are what the compaction watcher reads to know
 * which model a conversation is on, and the order it names is still the right one.
 */
export function forgetRoutingMemory() {
	trailsBySession.clear();
	announced.clear();
	for (const key of [...bySession.keys()]) {
		if (key.endsWith(`:${ROUTED}`)) bySession.delete(key);
	}
}

/**
 * Say where a call went — the first time, and whenever it changes.
 *
 * Logging every request buried the switches among identical lines, which is why
 * the log said nothing about when routing moved or why. Only a change is worth
 * a line, and a change is exactly where the reason belongs.
 */
function announceRoute(input: {
	db: Database;
	key: string;
	modelID?: string;
	next: { alias: string; providerID: string };
}) {
	const { db, key, modelID, next } = input;
	const before = announced.get(key);
	if (
		before &&
		before.providerID === next.providerID &&
		before.alias === next.alias
	) {
		return;
	}
	announced.set(key, next);
	const prefix = modelID ? `${modelID}: ` : "";
	const to = `${next.providerID}/${next.alias}`;
	if (!before) {
		recordLog("route", `${prefix}${to} (first choice)`);
		return;
	}
	const from = `${before.providerID}/${before.alias}`;
	const because = isParked(db, before.providerID, before.alias)
		? "the previous target is parked"
		: "moved on";
	recordLog("route", `${prefix}${from} → ${to} (${because})`);
}

/**
 * The failure in the endpoint's own words where it gave any, its status next,
 * and what it calls itself last. A park the panel cannot explain reads exactly
 * like a bug, so one of these always lands.
 */
function describeFailure(error: unknown, status?: number) {
	const value = error as
		| { message?: unknown; name?: unknown; type?: unknown; _tag?: unknown }
		| undefined;
	const described =
		typeof value?.message === "string" ? value.message.trim() : "";
	const named = [value?.name, value?.type, value?._tag]
		.filter(
			(part): part is string => typeof part === "string" && part.trim() !== "",
		)
		.join(" ");
	return (
		described ||
		(typeof status === "number" ? `HTTP ${status}` : "") ||
		named ||
		"the host reported a failure with no detail"
	);
}

/**
 * Record, durably, why a failure was handed to the session.
 *
 * `recordLog` lives only for the run of the plugin, so a reload — and any edit
 * to `v2/` causes one — erased the only evidence of which branch let a failure
 * through. This writes the same thing into the store, so "why did the session
 * see that" is still answerable afterwards. Both go down: the panel gets the
 * live line, and the store keeps the record.
 */
function recordHandedOver(input: {
	db: Database;
	from: string;
	providerID: string;
	alias: string;
	branch: string;
	reported: string;
}) {
	appendEvent(input.db, {
		alias: input.alias,
		message: `${input.from} was handed to the session: ${input.branch}${
			input.reported ? ` — ${input.reported.slice(0, 200)}` : ""
		}`,
		metadata: { branch: input.branch },
		providerID: input.providerID,
		type: "error_reached_session",
	});
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
}) {
	const { db, family, sessionID } = input;
	// A trail older than the idle window is void, so the balance starts again.
	forgetStaleTrail(db, sessionID);
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

	return (
		(pinned ? chooseRouteForRequest(db, pinned, tried) : undefined) ??
		chooseRouteForRequest(db, family, tried) ??
		// Everything has been tried since the last answer: wrap around.
		chooseRouteForRequest(db, family)
	);
}

/**
 * The row and connector a session's latest routed call went through, which is
 * what the compaction watcher measures the conversation against.
 *
 * Undefined when the session's calls never went through the balancer, or when
 * it has not made one recently enough to still be on it: a session that has
 * moved to a provider the balancer does not route must not be compacted here.
 */
export function balancerTargetFor(
	sessionID: string,
): { familyKey: string; providerID: string; context?: number } | undefined {
	const tracked = bySession.get(sessionKey(sessionID, ROUTED));
	if (!tracked || !fresh(tracked) || !tracked.familyKey) return undefined;
	return {
		context: tracked.context,
		familyKey: tracked.familyKey,
		providerID: tracked.providerID,
	};
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
			context: route.context,
			familyKey: family.key,
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

			const route = chooseStickyRoute({
				db,
				family,
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
			announceRoute({
				db,
				key: sessionKey(event.sessionID, ROUTED),
				modelID: family.key,
				next: { alias: route.account.alias, providerID: route.providerID },
			});
			markAccountUsed(db, route.providerID, route.account.alias);
			byRequest.set(request, {
				alias: route.account.alias,
				at: now(),
				context: route.context,
				familyKey: family.key,
				providerID: route.providerID,
			});
			track(event.sessionID, {
				alias: route.account.alias,
				at: now(),
				context: route.context,
				familyKey: family.key,
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

		announceRoute({
			db,
			key: sessionKey(event.sessionID, providerID),
			next: { alias: account.alias, providerID: account.providerID },
		});
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
		// Only a status the provider rejected counts as a failure: the classifier
		// treats an unrecognised failure as retryable, so an answer must be
		// excluded before it is asked about.
		const failed = event.response.status >= 400;
		if (!failed || !isRetryableFailure({ status: event.response.status })) {
			// An answer ends the failover trail: the session stays on this
			// target and a later failure may try the others again.
			trailsBySession.delete(event.sessionID);
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

	// The host will not retry a failure it has classified as deterministic, and
	// a quota cap is exactly that, so the only thing that can keep the text out
	// of the conversation is this hook setting the decision itself. It is also
	// the last moment before the session records a cut-off, which is why every
	// outcome is logged — including the ones that let the failure through.
	await ctx.session.hook("retry", async (event) => {
		const status = (event.error as { status?: number } | undefined)?.status;
		const reported = describeFailure(event.error, status);
		const tracked = lookupTracked({
			providerID: event.model.providerID,
			sessionID: event.sessionID,
		});
		if (!tracked) {
			// A routed call always has a target on record; losing it means the
			// failure cannot be charged to anyone, which the panel must say.
			if (event.model.providerID === BALANCER_PROVIDER_ID) {
				recordLog(
					"error",
					`a routed call failed with no target on record: ${reported.slice(0, 120)}`,
				);
				recordHandedOver({
					alias: "",
					branch: "no target on record",
					db,
					from: `${event.model.providerID} (routed)`,
					providerID: event.model.providerID,
					reported,
				});
			}
			return;
		}

		const from = `${tracked.providerID}/${tracked.alias}`;
		if (!isRetryableFailure({ error: event.error, status })) {
			recordLog(
				"error",
				`${from} failed and is not the account's fault, so the session sees it: ${reported.slice(0, 120)}`,
			);
			recordHandedOver({
				alias: tracked.alias,
				branch: "not the account's fault",
				db,
				from,
				providerID: tracked.providerID,
				reported,
			});
			return;
		}

		// Park before deciding, so a failure that cannot be passed on still
		// leaves the account out of the next selection.
		const park = Math.min(
			errorRetryAfterMs(event.error) ?? 60_000,
			MAX_PARK_MS,
		);
		markRateLimited(db, tracked.providerID, tracked.alias, park, reported);
		triedFor(event.sessionID).add(
			accountKey(tracked.providerID, tracked.alias),
		);

		if (!getBalancingEnabled(db)) {
			recordLog(
				"failover",
				`${from} failed: ${reported.slice(0, 120)}; balancing is off, so the session sees it`,
			);
			recordHandedOver({
				alias: tracked.alias,
				branch: "balancing is off",
				db,
				from,
				providerID: tracked.providerID,
				reported,
			});
			return;
		}

		const routed = event.model.providerID === BALANCER_PROVIDER_ID;
		const family = routed
			? await familyFor(ctx, db, event.model.id)
			: undefined;
		const canContinue = routed
			? Boolean(
					family &&
						hasAlternativeRoute(
							db,
							family,
							accountKey(tracked.providerID, tracked.alias),
						),
				)
			: hasAlternativeAccount(db, tracked.providerID, tracked.alias);
		if (!canContinue) {
			recordLog(
				"error",
				`no alternative to ${from}: the session sees the error`,
			);
			recordHandedOver({
				alias: tracked.alias,
				branch: "no alternative",
				db,
				from,
				providerID: tracked.providerID,
				reported,
			});
			return;
		}

		// Past a few rounds the chain has wrapped and re-walking it would only
		// hide the reason, so the real failure is handed over instead. The count
		// is the session's own list of credentials it has tried since its last
		// answer, not the host's `event.attempt`: the host never resets that one,
		// so a long-lived session — every failure it ever had, added up — would
		// eventually cross the cap and be cut off from failover for good.
		const triedNow = triedFor(event.sessionID).size;
		if (triedNow > ATTEMPT_CAP) {
			recordLog(
				"error",
				`${from} failed after ${triedNow} targets tried; the session sees the error`,
			);
			recordHandedOver({
				alias: tracked.alias,
				branch: "attempt cap",
				db,
				from,
				providerID: tracked.providerID,
				reported,
			});
			return;
		}

		// Forget the call's target so the retry routes from scratch; the account
		// just marked limited is skipped by the health check.
		bySession.delete(sessionKey(event.sessionID, ROUTED));
		bySession.delete(sessionKey(event.sessionID, tracked.providerID));

		recordLog(
			"failover",
			`${from} failed: ${reported.slice(0, 120)}; moving to the next target`,
		);
		event.decision = { delay: 0, retry: true };
	});
}
