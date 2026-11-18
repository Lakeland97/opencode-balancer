import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	accountKey,
	getAccount,
	getActiveAccount,
	markAccountUsed,
} from "../core/accounts";
import { writeCompactPromptTokens } from "../core/context";
import { appendEvent } from "../core/events";
import { getBalancingEnabled } from "../core/priority";
import { rebalanceAfterMs } from "../core/rebalance";
import { formatRollover } from "../core/rollover";
import { now } from "../core/time";
import { applyAuthToHeaders } from "./apply-auth";
import {
	BALANCER_BASE_URL,
	BALANCER_PROVIDER_ID,
	loadCatalog,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import { recordLog } from "./log";
import { noteModelUnavailable } from "./model-availability";
import { promptTokensFrom, summaryPromptTokensFrom } from "./prompt-size";
import {
	errorRetryAfterMs,
	isModelRefusal,
	isOverflowFailure,
	isRetryableFailure,
	isTimeoutFailure,
	markRateLimited,
	retryAfterMs,
} from "./request-state";
import {
	forgetServed,
	forgetSessionTokens,
	noteAnswered,
	noteIdle,
	noteServed,
	noteSessionRow,
	noteSessionTokens,
	servedEntries,
	servedFor,
	sessionRows,
	sessionTokens,
} from "./route-memory";
import {
	type ChosenRoute,
	chooseLargestTarget,
	chooseLastServed,
	chooseRouteAtAnyCost,
	chooseRouteForRequest,
	chooseRouteIgnoringParks,
	describeUnroutable,
	hasAlternativeRoute,
	rewriteModel,
	routedURL,
} from "./routing";
import { hasAlternativeAccount, selectHealthyAccount } from "./selection";
import { mapVariant, rewriteVariant } from "./variants";

/**
 * The model row a session is running on, as the compaction watcher needs it:
 * which row, which connector answered, and the real window that connector holds.
 */
export type SessionTarget = {
	familyKey: string;
	providerID: string;
	context?: number;
};

type Tracked = {
	providerID: string;
	alias: string;
	at: number;
	/** The row the call routed, and the window the connector that took it holds. */
	familyKey?: string;
	/** The connector's own id for the model, once a free variant has been swapped in. */
	modelID?: string;
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
// The host's own housekeeping in a session: a title, a summary, a one-off
// generation. These run in the session but they are not the conversation, so
// their model must not become the one the conversation is measured against.
const AUXILIARY_KINDS = new Set(["title", "generate", "compaction"]);

/**
 * Sessions that have already been compacted once because a request overflowed.
 *
 * A compaction is asynchronous: the retry can arrive before the summary lands. One
 * unattended re-compaction per session is the useful amount — a second overflow
 * after that means compacting is not the answer, and the turn should say so
 * instead of spinning.
 */
const overflowCompacted = new Set<string>();

function sessionKey(sessionID: string, providerID: string) {
	return `${sessionID}:${providerID}`;
}

/**
 * One model row's routing memory, in one session.
 *
 * The model — not the session — is what the memory is about, because a session
 * may run more than one: the user switches models mid-conversation, and the
 * host's own auxiliary calls (a title, a summary, a one-off generation) may use
 * another row again. Keyed by session alone, a pin or a trail from one model was
 * handed to the next: the other row's provider was filtered out of this row's
 * targets, so stickiness was lost on every switch, and failures from one model
 * counted against another's room to fail over. A row only ever holds the
 * providers that offer its model, so this is the whole of the per-model
 * allocation: the row is the model, and this is the row's memory.
 */
function modelKey(sessionID: string, familyKey: string) {
	return `${sessionID}:${ROUTED}:${familyKey}`;
}

/** Whether a routing slot belongs to the balancer rather than a real provider. */
function isRoutedSlot(key: string) {
	return key.split(":")[1] === ROUTED;
}

function track(sessionID: string, tracked: Tracked, familyKey?: string) {
	bySession.set(sessionKey(sessionID, tracked.providerID), tracked);
	if (familyKey) {
		// The balance is the client's: the pin is shared by every session of the
		// row, while the slot under this session's key stays behind for charging
		// this session's own request to the credential it used.
		bySession.set(modelKey(sessionID, familyKey), tracked);
		pinnedByRow.set(familyKey, tracked);
	}
	// Kept for any lookup that cannot name the row: a failure reported without a
	// model id still has to be charged to the credential that was in use.
	bySession.set(sessionKey(sessionID, ROUTED), tracked);
}

/**
 * The route one model request chose, kept for the HTTP requests that carry it.
 * The host's HTTP stack retries a failed request on its own, and each of those
 * retries must stay on the credential the request was routed to: re-selecting
 * there turns one failure into errors from several providers, and the retry
 * hook can only charge the last one it sees.
 */
type BoundRoute = { readonly at: number; readonly route: ChosenRoute };
const boundRoutes = new Map<string, BoundRoute>();
const PRIMARY_KIND = "primary";
// A bound route belongs to one in-flight model request, and a slow model can
// run longer than routing memory is trusted for. Refreshed on every HTTP
// attempt and cleared on failover, so this only bounds entries left behind by
// sessions that went away.
const BOUND_ROUTE_TTL_MS = 60 * 60_000;
const BOUND_ROUTE_SWEEP_AT = 256;

/**
 * Title and one-off generation run beside the conversation. They must use its
 * account so a failure belongs to the same credential, but they must not
 * replace the target a conversation failure is charged to.
 */
const SIDE_KINDS = new Set(["title", "generate"]);

function boundKey(sessionID: string, familyKey: string, kind: string) {
	return `${sessionID}\u0000${familyKey}\u0000${kind}`;
}

function boundRoute(sessionID: string, familyKey: string, kind: string) {
	const value = boundRoutes.get(boundKey(sessionID, familyKey, kind));
	return value && now() - value.at <= BOUND_ROUTE_TTL_MS
		? value.route
		: undefined;
}

function bindRoute(
	sessionID: string,
	familyKey: string,
	kind: string,
	route: ChosenRoute,
) {
	if (boundRoutes.size >= BOUND_ROUTE_SWEEP_AT) {
		const cutoff = now() - BOUND_ROUTE_TTL_MS;
		for (const [key, value] of boundRoutes) {
			if (value.at < cutoff) boundRoutes.delete(key);
		}
	}
	boundRoutes.set(boundKey(sessionID, familyKey, kind), {
		at: now(),
		route,
	});
}

/**
 * The request one target receives: the host's own request, pointed at the
 * connector, with the row's name replaced by the connector's id and the
 * thinking level translated onto that connector's own rung.
 *
 * Shared by the first attempt and by every retry inside this plugin, so a
 * retried call cannot differ from the first in anything but the target.
 */
async function prepareRoutedRequest(input: {
	family: ModelFamily;
	pristine: Request;
	route: ChosenRoute;
	/** The base the request is currently addressed to, when it is not the stub. */
	replaceBase?: string;
	variant: string | undefined;
}): Promise<Request> {
	const { family, pristine, replaceBase, route, variant } = input;
	let request = pristine;
	let url = routedURL(request.url, route.baseURL);
	// A request the model hook already pointed at a connector no longer names the
	// stub, so the host is not the thing to swap: the previous target is. Sending
	// it on with only its credential changed would deliver `p2`'s key to `p1`'s
	// endpoint.
	if (url === undefined && replaceBase) {
		const base = replaceBase.replace(/\/+$/, "");
		if (request.url.startsWith(base)) {
			url = `${route.baseURL}${request.url.slice(base.length)}`;
		}
	}
	if (url && url !== request.url) request = new Request(url, request);
	request = await rewriteModel(request, route.modelID, (body) => {
		// The host wrote the row's thinking level into the body. The target
		// may name that level differently, or not have it at all, so the
		// body is translated onto the rung this connector actually offers.
		rewriteVariant(
			body,
			mapVariant(variant, family.variants ?? []),
			mapVariant(variant, route.variants ?? []),
		);
	});
	const headers = new Headers(request.headers);
	applyAuthToHeaders(headers, route.account.auth);
	return new Request(request, { headers });
}

/**
 * Send one failed call to another target, without the session hearing about it.
 *
 * The response is read here, inside the plugin, so a spent credential's refusal
 * never becomes an attempt the host can record: it is parked, the next target is
 * chosen from the same row, and the request goes out again. Only when the targets
 * are exhausted does the caller get a response at all, and by then it is the last
 * target's own words rather than a failure this plugin invented.
 *
 * Every byte the session receives still comes from a real provider. Nothing is
 * synthesised.
 */
async function failoverResponse(input: {
	agent: string;
	db: Database;
	family: ModelFamily;
	kind: string;
	/** The target whose refusal started this walk. */
	original: ChosenRoute;
	/** Where that attempt was addressed, when it was not the stub itself. */
	originalBase: string;
	pending: PendingAttempt;
	sessionID: string;
	reported: string;
}): Promise<Response | undefined> {
	const {
		agent,
		db,
		family,
		kind,
		original,
		originalBase,
		pending,
		sessionID,
		reported,
	} = input;
	if (!getBalancingEnabled(db)) return undefined;
	const minContext = sessionTokens(db, sessionID);

	// A walk that ends with nothing to show must leave the row where it was: the
	// session is about to be told about the original refusal, and a title call or
	// the next request must not be pointed at a target this walk merely tried.
	//
	// The tracked slots go back too. Every attempt below rewrites them so a
	// failure reported mid-walk is charged to the target that answered it, and
	// leaving them rewritten once the walk gives up made the *next* hook charge
	// the original provider's words to whichever target happened to be tried
	// last — which is how a healthy provider ended up wearing another one's
	// error message in the panel.
	const before = {
		model: bySession.get(modelKey(sessionID, family.key)),
		provider: bySession.get(sessionKey(sessionID, original.providerID)),
		routed: bySession.get(sessionKey(sessionID, ROUTED)),
		served: servedFor(db, family.key),
	};
	const restore = (key: string, value: Tracked | undefined) => {
		if (value) bySession.set(key, value);
		else bySession.delete(key);
	};
	const abandon = () => {
		bindRoute(sessionID, family.key, kind, original);
		restore(modelKey(sessionID, family.key), before.model);
		restore(sessionKey(sessionID, ROUTED), before.routed);
		restore(sessionKey(sessionID, original.providerID), before.provider);
		// The panel's note is a claim about what is serving. A walk that produced
		// no answer served nothing, so the note goes back to the target whose
		// refusal the session is about to read — and stops claiming to be working
		// on a request that has already finished.
		if (before.served) {
			noteServed(db, family.key, { ...before.served, working: false });
		} else forgetServed(db, family.key);
		return undefined;
	};

	// A fresh request from the bytes the host wrote: a target cannot inherit the
	// previous target's URL, model id or credential, and the same bytes can be
	// sent as many times as there are targets.
	const template = () =>
		new Request(pending.url, {
			body: pending.body === undefined ? undefined : pending.body.slice(0),
			headers: pending.headers,
			method: pending.method,
		});
	// Each attempt is addressed to its own connector: the previous one is what
	// the request currently names, so that is what gets replaced.
	let base = originalBase;

	try {
		for (;;) {
			if (pending.failures >= ATTEMPT_CAP) return abandon();

			const route = chooseRouteForRequest(
				db,
				family,
				pending.tried,
				minContext,
			);
			// Nothing left in this row. The session is handed the last refusal that
			// was actually returned, so the words it reads are a provider's own.
			if (!route) return abandon();

			pending.failures += 1;
			const applied = mapVariant(pending.variant, route.variants ?? [])?.id;
			// Bound before the send, so a failure reported for this attempt — by
			// the host, if it ever sees one — is charged to the target that
			// actually answered it.
			bindRoute(sessionID, family.key, kind, route);
			announceRoute({
				db,
				key: family.key,
				modelID: family.key,
				next: { alias: route.account.alias, providerID: route.providerID },
				reason: `retrying after ${reported.slice(0, 60)}`,
			});
			if (!pending.side) {
				noteServed(db, family.key, {
					agent,
					alias: route.account.alias,
					applied,
					modelID: route.modelID,
					providerID: route.providerID,
					variant: pending.variant,
					working: true,
				});
			}
			markAccountUsed(db, route.providerID, route.account.alias);
			const tracked = {
				alias: route.account.alias,
				at: now(),
				context: route.context,
				familyKey: family.key,
				modelID: route.modelID,
				providerID: route.providerID,
			};
			bySession.set(modelKey(sessionID, family.key), tracked);
			bySession.set(sessionKey(sessionID, ROUTED), tracked);
			bySession.set(sessionKey(sessionID, route.providerID), tracked);

			let request: Request;
			try {
				request = await prepareRoutedRequest({
					family,
					pristine: template(),
					replaceBase: base,
					route,
					variant: pending.variant,
				});
			} catch {
				return abandon();
			}
			base = route.baseURL;

			let response: Response;
			try {
				response = await fetch(request);
			} catch {
				// A transport failure is this target's, not the session's: record it
				// as a spent credential and walk on.
				pending.tried.add(accountKey(route.providerID, route.account.alias));
				markRateLimited(
					db,
					route.providerID,
					route.account.alias,
					60_000,
					reported,
				);
				byRequest.set(request, tracked);
				continue;
			}

			byRequest.set(request, tracked);
			if (response.ok) return response;

			const refusal = `HTTP ${response.status}${
				response.statusText ? ` ${response.statusText}` : ""
			}`;
			// A refusal the conversation caused, or one every target would repeat,
			// is not this account's: the session gets it rather than another walk.
			if (!isRetryableFailure({ status: response.status })) {
				bindRoute(sessionID, family.key, kind, original);
				return response;
			}

			pending.tried.add(accountKey(route.providerID, route.account.alias));
			markRateLimited(
				db,
				route.providerID,
				route.account.alias,
				retryAfterMs(response),
				refusal,
			);
			recordLog(
				"failover",
				`${route.providerID}/${route.account.alias} answered ${refusal}; retried inside the call`,
			);
			// The body is not read, so nothing is left holding the connection.
			await response.body?.cancel().catch(() => {});
		}
	} finally {
		// The attempt is over: whatever follows is a new model request, and it
		// must route from the row rather than from this walk's last guess.
		if (!pending.side) forgetAttempt(sessionID, family.key, kind);
	}
}

function clearBoundRoutes(sessionID: string, familyKey: string) {
	const prefix = `${sessionID}\u0000${familyKey}\u0000`;
	for (const key of [...boundRoutes.keys()]) {
		if (key.startsWith(prefix)) boundRoutes.delete(key);
	}
}

function forgetAttempt(sessionID: string, familyKey: string, kind: string) {
	pendingAttempts.delete(pendingKey(sessionID, familyKey, kind));
}

/**
 * What one routed call needs in order to be retried inside this plugin.
 *
 * A provider failure used to be handed to the host, which classified it, put it
 * in the conversation, and only then asked the retry hook what to do. Every
 * spent credential therefore reached the transcript as an error, even when the
 * next target would have answered. So the request is kept here, pristine — the
 * host's own body, still naming the virtual row — and the response hook can
 * send it again to another target before the session ever sees an attempt.
 *
 * `pristine` is a clone, not the routed request: the routed one has already had
 * its URL, model field and credential replaced, and a retry must start from what
 * the host actually wrote so each target gets its own baseURL and id.
 */
type PendingAttempt = {
	at: number;
	/** The host's own body, already read, so every attempt is built from it. */
	body: ArrayBuffer | undefined;
	headers: Headers;
	method: string;
	url: string;
	/** Whether this model request is the conversation or housekeeping beside it. */
	side: boolean;
	/** Accounts this model request has already been sent to. */
	tried: Set<string>;
	/** How many targets have answered a failure so far. */
	failures: number;
	/** The row's thinking level as the host asked for it. */
	variant?: string;
};

/**
 * Read the host's request into a shape a retry can rebuild from.
 *
 * One read, up front. Cloning the request instead and leaving the copy unread
 * would leave a tee'd branch buffering the whole conversation for the life of
 * the request, and a request that never fails would never release it.
 */
async function readAttempt(request: Request): Promise<{
	body: ArrayBuffer | undefined;
	headers: Headers;
	method: string;
	url: string;
}> {
	let body: ArrayBuffer | undefined;
	if (request.body !== null) {
		try {
			body = await request.arrayBuffer();
		} catch {
			body = undefined;
		}
	}
	return {
		body,
		headers: new Headers(request.headers),
		method: request.method,
		url: request.url,
	};
}

const pendingAttempts = new Map<string, PendingAttempt>();

// A retried call is still one model request, so the entry is dropped by the same
// sweep that bounds the bound routes rather than growing with every request.
const PENDING_CAP = 256;

function pendingKey(sessionID: string, familyKey: string, kind: string) {
	return `${sessionID}\u0000${familyKey}\u0000${kind}`;
}

function pendingAttempt(
	sessionID: string,
	familyKey: string,
	kind: string,
): PendingAttempt | undefined {
	const entry = pendingAttempts.get(pendingKey(sessionID, familyKey, kind));
	return entry && now() - entry.at <= BOUND_ROUTE_TTL_MS ? entry : undefined;
}

function rememberAttempt(
	sessionID: string,
	familyKey: string,
	kind: string,
	pristine: Awaited<ReturnType<typeof readAttempt>>,
	tried: Set<string>,
	input: { side: boolean; variant?: string },
) {
	if (pendingAttempts.size >= PENDING_CAP) {
		const cutoff = now() - BOUND_ROUTE_TTL_MS;
		for (const [key, entry] of pendingAttempts) {
			if (entry.at < cutoff) pendingAttempts.delete(key);
		}
	}
	pendingAttempts.set(pendingKey(sessionID, familyKey, kind), {
		...pristine,
		at: now(),
		failures: 0,
		side: input.side,
		tried,
		variant: input.variant,
	});
}

/**
 * A side call uses the conversation's current target when there is one. It is
 * allowed to send to a parked credential: the park describes the next choice,
 * not a request already bound for that account, and sending elsewhere is what
 * put two providers' errors on one attempt.
 */
function chooseSideRoute(input: {
	db: Database;
	family: ModelFamily;
	sessionID: string;
}) {
	const primary = boundRoute(input.sessionID, input.family.key, PRIMARY_KIND);
	if (primary) {
		const account = getAccount(
			input.db,
			primary.providerID,
			primary.account.alias,
		);
		if (account && !account.disabled) {
			return { parkedFallback: false as const, route: { ...primary, account } };
		}
	}
	return chooseStickyRoute(input);
}

function fresh(tracked: Tracked) {
	return now() - tracked.at <= STALE_AFTER_MS;
}

/** Whether an account is currently sitting out its cooldown. */
function isParked(db: Database, providerID: string, alias: string) {
	const account = getAccount(db, providerID, alias);
	return Boolean(account?.rateLimitedUntil && account.rateLimitedUntil > now());
}

/**
 * The row this client is balanced on: the provider that last answered it, and
 * the credentials already tried since.
 *
 * The balance belongs to the client, not to a session. Every session sending
 * the same model is sending the same request to the same quota, so the unit
 * that fails over is the row: one conversation hitting a limit moves the whole
 * client to the next target, and a new conversation starts where the client
 * already is instead of walking back onto the exhausted credential. Keyed by
 * session, each tab kept its own private idea of the order and re-hit the same
 * dead account again and again.
 *
 * Which credential served a particular request is a different question and is
 * still per session: a failure has to be charged to the account that request
 * actually used. That stays on `bySession` under the session key.
 */
type Trail = { at: number; tried: Set<string> };
const trailsByRow = new Map<string, Trail>();
/** The target each row last answered on, shared by every session of the row. */
const pinnedByRow = new Map<string, Tracked>();

function trailFor(familyKey: string) {
	let trail = trailsByRow.get(familyKey);
	if (!trail) {
		trail = { at: now(), tried: new Set() };
		trailsByRow.set(familyKey, trail);
	}
	return trail;
}

function triedFor(familyKey: string) {
	const trail = trailFor(familyKey);
	trail.at = now();
	return trail.tried;
}

// The model rows a session has had a conversation on, so the compaction watcher
// measures the conversation against the window it will actually be sent to. Only
// primary calls are recorded: a title or a summary is the host doing housekeeping
// in the same session, and its model must not decide where the conversation is
// cut.
type RecordedTarget = { at: number; target: SessionTarget };
const targetsBySession = new Map<string, Map<string, RecordedTarget>>();

function recordTarget(db: Database, sessionID: string, target: SessionTarget) {
	let rows = targetsBySession.get(sessionID);
	if (!rows) {
		rows = new Map();
		targetsBySession.set(sessionID, rows);
	}
	rows.set(target.familyKey, { at: now(), target });
	// Written through to the store: a reload would otherwise leave the
	// compaction watcher with no row to measure, and a conversation nothing
	// measures is a conversation nothing compacts.
	noteSessionRow(db, sessionID, {
		context: target.context,
		familyKey: target.familyKey,
		providerID: target.providerID,
	});
}

// The target each row was last announced on, so a switch can name where it came
// from. Kept apart from the routing slots above, which the failover path
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
function forgetStaleTrail(db: Database, familyKey: string) {
	const trail = trailsByRow.get(familyKey);
	if (!trail) return;
	const window = rebalanceAfterMs(db);
	// Zero is the window switched off, so nothing ages a trail out but a change to
	// the order itself.
	if (window <= 0) return;
	if (now() - trail.at <= window) return;
	trailsByRow.delete(familyKey);
	announced.delete(familyKey);
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
 * The per-provider slots stay. They are what a failure is charged to, and the
 * order they name is still the right one. The recorded targets stay too: they
 * describe which model a conversation is on, which no reorder changes.
 */
export function forgetRoutingMemory() {
	trailsByRow.clear();
	pinnedByRow.clear();
	announced.clear();
	boundRoutes.clear();
	pendingAttempts.clear();
	for (const key of [...bySession.keys()]) {
		if (isRoutedSlot(key)) bySession.delete(key);
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
	reason?: string;
}) {
	const { db, key, modelID, next, reason } = input;
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
		recordLog("route", `${prefix}${to} (${reason ?? "first choice"})`);
		return;
	}
	const from = `${before.providerID}/${before.alias}`;
	const because =
		reason ??
		(isParked(db, before.providerID, before.alias)
			? "the previous target is parked"
			: "moved on");
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
 * When the client's balance would next be dropped for sitting idle, in epoch
 * milliseconds, or `undefined` when nothing is counting down.
 *
 * Routing memory is per row, so different rows go stale at different moments.
 * The soonest one is what a single note can honestly say: it is the moment the
 * next request would start from the head of the order instead of continuing.
 * A window switched off has no such moment; a row with no trail has nothing to
 * forget yet.
 */
export function nextRebalanceAt(db: Database, at: number = now()) {
	const window = rebalanceAfterMs(db);
	if (window <= 0) return undefined;
	let soonest: number | undefined;
	// The served notes are the persisted record of each row's last routed
	// request, so the countdown survives a reload that a trail in memory does not.
	for (const entry of servedEntries(db, at)) {
		const due = entry.at + window;
		// A note already past its window is stale, not pending: the next request
		// drops it rather than waiting for it.
		if (due <= at) continue;
		if (soonest === undefined || due < soonest) soonest = due;
	}
	return soonest;
}

/**
 * Tell the conversation, once, why this row cannot be served.
 *
 * The message is a synthetic one rather than a thrown error: the turn still
 * fails on the provider request, which is an ordinary model error the client
 * already knows how to show, but the reason is in the transcript and the panel's
 * log instead of being inferable only from a stack trace. Announced through the
 * model-request hook's own session, so it lands in the conversation that asked.
 */
/**
 * Say that nothing can serve this model.
 *
 * The claim a provider makes when it refuses is about the conversation, and the
 * host has no way to separate "your prompt is wrong" from "every account is
 * spent". This message is the second half of that: it names what is exhausted,
 * when each comes back, and what the user can do now. It is a status line, not a
 * failure — the turn still ends, because there is nothing honest to answer with.
 *
 * One per request, deliberately: a second attempt is a second thing the user
 * asked for, so it earns its own answer rather than being suppressed as a repeat.
 */
async function announceUnroutable(
	ctx: Context,
	db: Database,
	sessionID: string,
	family: ModelFamily,
) {
	const reasons = describeUnroutable(db, family).map((reason) =>
		// The instant inside the line is an epoch timestamp; the panel reads it as
		// one, but a sentence in a conversation does not.
		reason.replace(/limited until (\S+)$/, (_whole, iso: string) => {
			const at = Date.parse(iso);
			return Number.isFinite(at)
				? `limited until ${formatRollover(at, now())}`
				: `limited (${iso})`;
		}),
	);
	const text = [
		`Balancer: nothing can serve ${family.key} right now.`,
		...reasons.map((reason) => `- ${reason}`),
		"Open the Balancer panel to add a target, or wait for the limited credentials to reset.",
	].join("\n");
	recordLog("error", text.replace(/\n/g, " "));
	try {
		await ctx.session.synthetic({
			description: `no target can serve ${family.key}`,
			sessionID,
			text,
		});
	} catch (error) {
		// A host that will not take a synthetic message must not turn this into a
		// second failure: the log line above already carries the reason.
		recordLog(
			"error",
			`could not tell the session why ${family.key} is unroutable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * One route choice for both request hooks. The row keeps the target that last
 * answered while it is healthy, so a conversation stays on the model it shifted
 * to instead of snapping back to the top of the chain. Targets already tried
 * since the last answer are skipped; if that leaves nothing, the chain wraps
 * around to the head; if even that leaves nothing, the row's head is tried
 * anyway rather than the call being left unrouted.
 */
function chooseStickyRoute(input: {
	db: Database;
	family: ModelFamily;
	sessionID: string;
}): { parkedFallback: boolean; route: ChosenRoute } | undefined {
	const { db, family, sessionID } = input;
	// A conversation that already fills more than a target's window cannot be
	// handed to it: the provider would reject the whole request, which reads as
	// a failure of the account when it is really the row's own target choice.
	const minContext = sessionTokens(db, sessionID);
	// A trail older than the idle window is void, so the balance starts again.
	forgetStaleTrail(db, family.key);
	const tried = triedFor(family.key);
	const remembered = pinnedByRow.get(family.key);
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

	const route =
		(pinned
			? chooseRouteForRequest(db, pinned, tried, minContext)
			: undefined) ??
		chooseRouteForRequest(db, family, tried, minContext) ??
		// Everything has been tried since the last answer: wrap around.
		chooseRouteForRequest(db, family, undefined, minContext);
	if (route) return { parkedFallback: false, route };

	// Nothing healthy can answer this row at all. The row holds only providers
	// that offer the model, so there is no alternative the park is protecting:
	// trying the head again is better than leaving the call pointed at the stub.
	const lastChance =
		chooseRouteIgnoringParks(db, family, tried, minContext) ??
		chooseRouteIgnoringParks(db, family, undefined, minContext) ??
		// Every target's window is too small for this conversation. Handing it to
		// one anyway is what produced a hard overflow from a model that had never
		// seen this conversation: the provider rejects the whole request, and the
		// failure reads as the account's. The widest target is the only one that
		// might still fit, and its refusal names the real limit when nothing does.
		chooseLargestTarget(db, family, tried) ??
		chooseLargestTarget(db, family) ??
		// The row is unroutable by every rule the balancer has. The one fact left
		// is which target last answered it, and a session that was working a
		// minute ago should keep working on the model it was on rather than stop
		// because the plugin's own bookkeeping went bad. If that credential really
		// is spent, the provider will say so in its own words.
		chooseLastServed(db, family, tried) ??
		chooseLastServed(db, family) ??
		// Nothing has ever answered this row in this store, so there is no last
		// good target to fall back to. Every target is marked as refusing this
		// model, which is the balancer's own guess rather than this request's
		// answer, and leaving the call pointed at the stub sends it to a host name
		// that does not resolve. Trying a real target is the only way to find out
		// whether the guess still holds.
		chooseRouteAtAnyCost(db, family, tried) ??
		chooseRouteAtAnyCost(db, family);
	return lastChance ? { parkedFallback: true, route: lastChance } : undefined;
}

/**
 * The model rows a session has had a conversation on, which is what the
 * compaction watcher measures against.
 *
 * Every row the session has run is returned, not just the last: a conversation
 * that moves between models has to fit all of them, and the watcher takes the
 * smallest threshold rather than the newest one. Rows that have gone stale are
 * dropped — a session the balancer has not routed recently may have moved to a
 * provider this plugin does not hold, and its conversation is then not ours to
 * compact.
 */
export function balancerTargetsFor(
	db: Database,
	sessionID: string,
): SessionTarget[] {
	const rows = targetsBySession.get(sessionID);
	const live = rows
		? [...rows.values()].filter(
				(recorded) => now() - recorded.at <= STALE_AFTER_MS,
			)
		: [];
	const known = new Set(live.map((recorded) => recorded.target.familyKey));
	// The store is the record across a reload, so rows this run has not seen
	// are still this session's own conversation.
	for (const row of sessionRows(db, sessionID, now(), STALE_AFTER_MS)) {
		if (known.has(row.familyKey)) continue;
		live.push({
			at: row.at ?? now(),
			target: {
				context: row.context,
				familyKey: row.familyKey,
				providerID: row.providerID,
			},
		});
	}
	return live.map((recorded) => recorded.target);
}

function lookupTracked(input: {
	sessionID: string;
	providerID: string;
	request?: Request;
	familyKey?: string;
}): Tracked | undefined {
	if (input.request) {
		const direct = byRequest.get(input.request);
		if (direct) return direct;
	}
	if (input.familyKey && input.providerID === ROUTED) {
		// The row the call was for, when the caller could name it: with two models
		// in one session, the last routed call may belong to the other one. Only a
		// routed call can have a row, which is why the provider is checked first —
		// a direct call to a provider that happens to offer the same model would
		// otherwise find the balancer's slot for it and charge its failure there.
		const row = bySession.get(modelKey(input.sessionID, input.familyKey));
		if (row && fresh(row)) return row;
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
		const kind = String(event.kind);
		const side = SIDE_KINDS.has(kind);
		// The same route the request hook will pick, so the URL and credential
		// set here cannot point at a different provider than the one it uses.
		const chosen = side
			? chooseSideRoute({ db, family, sessionID: event.sessionID })
			: chooseStickyRoute({
					db,
					family,
					sessionID: event.sessionID,
				});
		if (!chosen) {
			// Nothing in the row can answer, and leaving the call pointed at the
			// stub is what turned this into an unexplainable transport failure. Say
			// what is wrong in the conversation itself, in one message, and let the
			// request fail as an ordinary provider error rather than a system one.
			if (!side) await announceUnroutable(ctx, db, event.sessionID, family);
			return;
		}
		const route = chosen.route;
		bindRoute(event.sessionID, family.key, kind, route);

		event.baseURL = route.baseURL;
		const headers = new Headers(event.headers);
		applyAuthToHeaders(headers, route.account.auth);
		event.headers = Object.fromEntries(headers);

		// A side call is not the conversation serving: it must not report the
		// account as in use (which clears its park) or replace the target a
		// conversation failure will be charged to.
		if (side) return;

		noteServed(db, family.key, {
			agent: String(event.agent),
			alias: route.account.alias,
			// The level the connector is actually asked for. `route.variants` is
			// this target's own ladder, so a row asking for `max` on a connector
			// that tops out at `high` reports `high`, which is what is running.
			applied: mapVariant(event.model.variant, route.variants ?? [])?.id,
			modelID: route.modelID,
			providerID: route.providerID,
			variant: event.model.variant,
			// The request is on its way; the answer clears this. It is what lets
			// the panel say a row is working rather than counting how long ago it
			// last answered, which for a slow model is the whole of the wait.
			working: true,
		});
		markAccountUsed(db, route.providerID, route.account.alias);
		track(
			event.sessionID,
			{
				alias: route.account.alias,
				at: now(),
				context: route.context,
				familyKey: family.key,
				modelID: route.modelID,
				providerID: route.providerID,
			},
			family.key,
		);
		// Recorded here as well as in the request hook, which covers the same
		// call: either hook alone has to leave the watcher with the right row,
		// and writing the same target twice is not a change.
		if (!AUXILIARY_KINDS.has(String(event.kind))) {
			recordTarget(db, event.sessionID, {
				context: route.context,
				familyKey: family.key,
				providerID: route.providerID,
			});
		}
	});

	await ctx.session.hook("http.request", async (event) => {
		const providerID = event.model.providerID;

		// The floor a reserve is held to is the size of the instruction the summary
		// request carries, so it is measured from the request itself rather than
		// assumed, and it follows the host if its prompt ever changes. A body that
		// cannot be read leaves the last measurement standing.
		if (event.kind === "compaction") {
			const measured = await summaryPromptTokensFrom(event.request);
			if (measured !== undefined) writeCompactPromptTokens(db, measured);
		}

		if (providerID === BALANCER_PROVIDER_ID) {
			// The model-request hook already retargeted the URL and credential;
			// this replaces the virtual family name with the connector's id and
			// covers the case where that hook did not run.
			const family = await familyFor(ctx, db, event.model.id);
			if (!family) return;

			const kind = String(event.kind);
			const side = SIDE_KINDS.has(kind);
			// The prompt on the wire is the one figure routing cannot infer from
			// the host: every balancer row is declared at 1M, so nothing else stops
			// a conversation that has outgrown a target from being sent to it. It is
			// measured when the balancer has no figure of its own — a session it has
			// never seen, or one that was running before the plugin loaded — and
			// otherwise the step-end measurement keeps the figure current. Reading
			// every body would cost a copy of the conversation on every request for
			// a number the host already reports after each step.
			if (
				!side &&
				kind === PRIMARY_KIND &&
				sessionTokens(db, event.sessionID) === undefined
			) {
				const prompt = await promptTokensFrom(event.request);
				if (prompt !== undefined) {
					noteSessionTokens(db, event.sessionID, prompt);
				}
			}
			// Reuse the route this model request chose. The host's HTTP stack
			// retries the request itself, and choosing a new credential for each
			// retry is what mixed two providers' errors into one attempt.
			let route = boundRoute(event.sessionID, family.key, kind);
			if (
				route &&
				typeof route.context === "number" &&
				route.context > 0 &&
				route.context < (sessionTokens(db, event.sessionID) ?? 0)
			) {
				// The model request chose before the prompt could be measured, and
				// this target cannot hold what is about to be sent to it. Sending it
				// anyway is the hard overflow the provider reports as its own fault.
				clearBoundRoutes(event.sessionID, family.key);
				route = undefined;
			}
			let parkedFallback = false;
			if (!route) {
				const chosen = side
					? chooseSideRoute({ db, family, sessionID: event.sessionID })
					: chooseStickyRoute({
							db,
							family,
							sessionID: event.sessionID,
						});
				if (!chosen) {
					if (!side) {
						await announceUnroutable(ctx, db, event.sessionID, family);
					}
					return;
				}
				route = chosen.route;
				parkedFallback = chosen.parkedFallback;
			}
			bindRoute(event.sessionID, family.key, kind, route);

			// What the host actually wrote, before this plugin touched it. A retry
			// to another target has to start from here: the routed request below
			// already names one connector's URL and model id, and sending that to
			// a different provider is the failure this copy exists to prevent.
			const pristine = await readAttempt(event.request);

			const variant = event.model.variant;
			const request = await prepareRoutedRequest({
				family,
				// A fresh stream from the bytes just read: the host's own request
				// has already been consumed by `readAttempt`.
				pristine: new Request(pristine.url, {
					body:
						pristine.body === undefined ? undefined : pristine.body.slice(0),
					headers: pristine.headers,
					method: pristine.method,
				}),
				route,
				variant,
			});

			event.request = request;
			if (!side) {
				announceRoute({
					db,
					// Per row: the balance is the client's, so one switch is one line,
					// whichever session happened to make it.
					key: family.key,
					modelID: family.key,
					next: { alias: route.account.alias, providerID: route.providerID },
					reason: parkedFallback
						? "nothing healthy could answer; trying it anyway"
						: undefined,
				});
				noteServed(db, family.key, {
					agent: String(event.agent),
					alias: route.account.alias,
					applied: mapVariant(event.model.variant, route.variants ?? [])?.id,
					modelID: route.modelID,
					providerID: route.providerID,
					variant: event.model.variant,
					working: true,
				});
				markAccountUsed(db, route.providerID, route.account.alias);
			}
			const tracked = {
				alias: route.account.alias,
				at: now(),
				context: route.context,
				familyKey: family.key,
				modelID: route.modelID,
				providerID: route.providerID,
			};
			byRequest.set(request, tracked);
			// The attempt this call may have to repeat. Only a routed call can be
			// retried from here — the request has to be one this plugin can
			// re-point at another target, and its targets are a row's.
			rememberAttempt(
				event.sessionID,
				family.key,
				kind,
				pristine,
				new Set([accountKey(route.providerID, route.account.alias)]),
				{ side, variant },
			);
			// A side call keeps its failure on its own request, so the response
			// hook charges the right credential, but never rewrites the
			// conversation's remembered target.
			if (!side) {
				track(event.sessionID, tracked, family.key);
				// Where the conversation is running, for the compaction watcher. An
				// auxiliary call — a title, a summary, a one-off generation — is the
				// host doing housekeeping in the same session, and its model must not
				// decide where that conversation is cut. Anything else counts as the
				// conversation, including a kind this host has not told us about:
				// refusing to record would mean refusing to compact, and a session
				// that quietly stops being compacted overflows instead.
				if (!AUXILIARY_KINDS.has(String(event.kind))) {
					recordTarget(db, event.sessionID, {
						context: route.context,
						familyKey: family.key,
						providerID: route.providerID,
					});
				}
			}
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

	await ctx.session.hook("http.response", async (event) => {
		const tracked = lookupTracked({
			familyKey: event.model.id,
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
			// An answer ends the failover trail for this row: the client stays on
			// this target and a later failure may try the others again.
			if (tracked.familyKey) {
				trailsByRow.delete(tracked.familyKey);
				// The clock the panel shows is "when this row last answered", so an
				// answer is what stamps it. A slow model used to leave the panel
				// saying "3m ago" for the whole three minutes it was generating.
				noteAnswered(db, tracked.familyKey);
			}
			return;
		}
		// A refusal is not an answer: nothing is working on this row any more, and
		// the clock must not move as if something had answered.
		if (tracked.familyKey) noteIdle(db, tracked.familyKey);
		const reported = `HTTP ${event.response.status}${
			event.response.statusText ? ` ${event.response.statusText}` : ""
		}`;

		// A call that is not one of this balancer's rows — a provider used
		// directly — cannot be retried here: there is no row to choose from, so
		// the park is the whole of this hook's work.
		if (!tracked.familyKey) {
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
			return;
		}

		// The credential that answered is spent whatever happens next, and it
		// is parked first so the walk below cannot pick it again.
		markRateLimited(
			db,
			tracked.providerID,
			tracked.alias,
			retryAfterMs(event.response),
			reported,
		);

		// The last moment at which the failure can be kept out of the session.
		// Everything the host could do with it — classify it, record it, ask the
		// retry hook, put a cut-off in the transcript — happens after this hook
		// returns, so a refusal another target can answer is answered here and the
		// session is handed that answer instead. What it sees is a slow turn.
		{
			const family = await familyFor(ctx, db, tracked.familyKey);
			const pending = pendingAttempt(
				event.sessionID,
				tracked.familyKey,
				String(event.kind),
			);
			if (family && pending) {
				const replacement = await failoverResponse({
					agent: String(event.agent),
					db,
					family,
					kind: String(event.kind),
					original: boundRoute(
						event.sessionID,
						tracked.familyKey,
						String(event.kind),
					) ?? {
						account: { alias: tracked.alias } as ChosenRoute["account"],
						available: true,
						baseURL: BALANCER_BASE_URL,
						modelID: tracked.modelID ?? tracked.familyKey,
						package: family.package,
						providerID: tracked.providerID,
					},
					// Where this attempt was sent, so the retry replaces that base
					// rather than assuming the request still names the stub.
					originalBase:
						boundRoute(event.sessionID, tracked.familyKey, String(event.kind))
							?.baseURL ?? BALANCER_BASE_URL,
					pending,
					reported,
					sessionID: event.sessionID,
				});
				if (replacement) {
					event.response = replacement;
					if (replacement.ok) {
						trailsByRow.delete(tracked.familyKey);
						// The answer is the event the panel's clock is about, and it
						// came from the target that answered rather than the one that
						// was asked first.
						noteAnswered(db, tracked.familyKey);
						return;
					}
					// Every target refused in words another would repeat. That is
					// the conversation's problem and the session must see it, but
					// nothing is still working on this row.
					noteIdle(db, tracked.familyKey);
					return;
				}
				noteIdle(db, tracked.familyKey);
			}
		}

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
			familyKey: event.model.id,
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

		const rowKey = event.model.id;
		const from = `${tracked.providerID}/${tracked.alias}`;

		// Three failures arrive here, and only one of them is about the account:
		//
		//   - a model the provider will not serve on this plan: the credential is
		//     fine, so the pair is marked and another target is tried;
		//   - a request that ran out of time: the same key answers the next call,
		//     so nothing is parked and only this row moves on;
		//   - anything else: the account is spent, limited, or unreachable.
		//
		// Parking on the first two is what made a slow model look limited and took
		// a provider out of rotation while the rest of its catalogue worked.
		const refusal = isModelRefusal({ error: event.error, status });
		const timeout = isTimeoutFailure({ error: event.error, status });
		const refusedModel = tracked.modelID ?? rowKey;

		// A conversation larger than the window it was sent to is nobody's fault
		// but this request's: the same prompt overflows on every target. The answer
		// is a smaller conversation, so compact and let the host try again — the
		// alternative is handing the raw overflow text to the session, which reads
		// as a provider failure and stops the turn.
		if (isOverflowFailure({ error: event.error, status })) {
			if (overflowCompacted.has(event.sessionID)) {
				// Compacting did not shrink it enough. Retrying forever would spin,
				// so the failure is handed over with the reason written down.
				overflowCompacted.delete(event.sessionID);
				recordLog(
					"error",
					`${from} overflowed after compacting: the conversation is larger than ${refusedModel} can hold: ${reported.slice(0, 120)}`,
				);
				recordHandedOver({
					alias: tracked.alias,
					branch: "overflow after compaction",
					db,
					from,
					providerID: tracked.providerID,
					reported,
				});
				return;
			}
			overflowCompacted.add(event.sessionID);
			// What was measured no longer describes the prompt.
			forgetSessionTokens(db, event.sessionID);
			recordLog(
				"compact",
				`${from} could not hold the conversation; compacting before trying again`,
			);
			try {
				await ctx.session.compact({ sessionID: event.sessionID });
			} catch (error) {
				overflowCompacted.delete(event.sessionID);
				recordLog(
					"error",
					`compaction after overflow failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				recordHandedOver({
					alias: tracked.alias,
					branch: "overflow, compaction failed",
					db,
					from,
					providerID: tracked.providerID,
					reported,
				});
				return;
			}
			event.decision = { delay: 0, retry: true };
			return;
		}

		if (refusal) {
			// The catalogue cannot know a plan, so the answer has to: remember the
			// pair for a while and let routing step over it.
			noteModelUnavailable(db, tracked.providerID, refusedModel);
			recordLog(
				"failover",
				`${from} refused ${refusedModel}: ${reported.slice(0, 120)}; the account stays, the model is skipped`,
			);
		}

		if (
			!refusal &&
			!timeout &&
			!isRetryableFailure({ error: event.error, status })
		) {
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
		// leaves the account out of the next selection. A timeout and a model
		// refusal are excluded on purpose: neither says the credential is spent.
		if (!refusal && !timeout) {
			const park = Math.min(
				errorRetryAfterMs(event.error) ?? 60_000,
				MAX_PARK_MS,
			);
			markRateLimited(db, tracked.providerID, tracked.alias, park, reported);
		}
		// Credentials this row has tried are always recorded, so a retry walks on
		// instead of re-picking the target that just failed — for a timeout that
		// is the whole of the response, since the account is left alone.
		triedFor(rowKey).add(accountKey(tracked.providerID, tracked.alias));

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
			// A row whose every target is spent has already been walked inside the
			// call, so there is no answer left to give. What the session must not
			// get is a bare error with no way forward: name what is spent, when it
			// comes back, and where to add a target. The provider's own failure
			// still reaches the session after this, because there is nothing honest
			// to replace it with.
			if (routed && family) {
				await announceUnroutable(ctx, db, event.sessionID, family);
			}
			return;
		}

		// Past a few rounds the chain has wrapped and re-walking it would only
		// hide the reason, so the real failure is handed over instead. The count
		// is this row's own list of credentials tried since its last answer, not
		// the host's `event.attempt`: the host never resets that one, so a
		// long-lived session — every failure it ever had, added up — would
		// eventually cross the cap and be cut off from failover for good. Counting
		// per row is what keeps one model's failures from spending another's room,
		// and the row is the model, so it is also the list the user can see.
		const triedNow = triedFor(rowKey).size;
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

		// Forget this row's target so the retry routes from scratch; the account
		// just marked limited is skipped by the health check either way. The pin
		// is the client's, so dropping it moves every session of this row on.
		clearBoundRoutes(event.sessionID, rowKey);
		pinnedByRow.delete(rowKey);
		bySession.delete(modelKey(event.sessionID, rowKey));
		bySession.delete(sessionKey(event.sessionID, ROUTED));
		bySession.delete(sessionKey(event.sessionID, tracked.providerID));

		recordLog(
			"failover",
			`${from} failed: ${reported.slice(0, 120)}; moving to the next target`,
		);
		event.decision = { delay: 0, retry: true };
	});
}
