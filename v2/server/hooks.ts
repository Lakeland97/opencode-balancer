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
import { now } from "../core/time";
import { applyAuthToHeaders } from "./apply-auth";
import {
	BALANCER_PROVIDER_ID,
	loadCatalog,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import { recordLog } from "./log";
import { summaryPromptTokensFrom } from "./prompt-size";
import {
	errorRetryAfterMs,
	isRetryableFailure,
	markRateLimited,
	retryAfterMs,
} from "./request-state";
import {
	type ChosenRoute,
	chooseRouteForRequest,
	chooseRouteIgnoringParks,
	hasAlternativeRoute,
	rewriteModel,
	routedURL,
} from "./routing";
import { hasAlternativeAccount, selectHealthyAccount } from "./selection";

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
	if (familyKey) bySession.set(modelKey(sessionID, familyKey), tracked);
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

function clearBoundRoutes(sessionID: string, familyKey: string) {
	const prefix = `${sessionID}\u0000${familyKey}\u0000`;
	for (const key of [...boundRoutes.keys()]) {
		if (key.startsWith(prefix)) boundRoutes.delete(key);
	}
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

// Credentials this row has already tried since its last answer, named
// `provider/alias`. A retry reads this so it moves forward through the chain
// instead of starting again at the first target and parking everything on the
// way down; naming the credential rather than the provider is what lets the
// second credential of a provider still answer.
//
// The trail carries its own clock because the routing slots cannot: the failover
// path clears those before a retry on purpose, so by the time the question is
// asked there is nothing there to date. `at` is refreshed by every routing
// decision, which makes it the last time this row was balanced.
type Trail = { at: number; tried: Set<string> };
const trailsByModel = new Map<string, Trail>();

function trailFor(sessionID: string, familyKey: string) {
	const key = modelKey(sessionID, familyKey);
	let trail = trailsByModel.get(key);
	if (!trail) {
		trail = { at: now(), tried: new Set() };
		trailsByModel.set(key, trail);
	}
	return trail;
}

function triedFor(sessionID: string, familyKey: string) {
	const trail = trailFor(sessionID, familyKey);
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

function recordTarget(sessionID: string, target: SessionTarget) {
	let rows = targetsBySession.get(sessionID);
	if (!rows) {
		rows = new Map();
		targetsBySession.set(sessionID, rows);
	}
	rows.set(target.familyKey, { at: now(), target });
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
function forgetStaleTrail(db: Database, sessionID: string, familyKey: string) {
	const key = modelKey(sessionID, familyKey);
	const trail = trailsByModel.get(key);
	if (!trail) return;
	const window = rebalanceAfterMs(db);
	// Zero is the window switched off, so nothing ages a trail out but a change to
	// the order itself.
	if (window <= 0) return;
	if (now() - trail.at <= window) return;
	trailsByModel.delete(key);
	announced.delete(key);
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
	trailsByModel.clear();
	announced.clear();
	boundRoutes.clear();
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
	// A trail older than the idle window is void, so the balance starts again.
	forgetStaleTrail(db, sessionID, family.key);
	const tried = triedFor(sessionID, family.key);
	const remembered = bySession.get(modelKey(sessionID, family.key));
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
		(pinned ? chooseRouteForRequest(db, pinned, tried) : undefined) ??
		chooseRouteForRequest(db, family, tried) ??
		// Everything has been tried since the last answer: wrap around.
		chooseRouteForRequest(db, family);
	if (route) return { parkedFallback: false, route };

	// Nothing healthy can answer this row at all. The row holds only providers
	// that offer the model, so there is no alternative the park is protecting:
	// trying the head again is better than leaving the call pointed at the stub.
	const lastChance =
		chooseRouteIgnoringParks(db, family, tried) ??
		chooseRouteIgnoringParks(db, family);
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
export function balancerTargetsFor(sessionID: string): SessionTarget[] {
	const rows = targetsBySession.get(sessionID);
	if (!rows) return [];
	const live = [...rows.values()].filter(
		(recorded) => now() - recorded.at <= STALE_AFTER_MS,
	);
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
		if (!chosen) return;
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

		markAccountUsed(db, route.providerID, route.account.alias);
		track(
			event.sessionID,
			{
				alias: route.account.alias,
				at: now(),
				context: route.context,
				familyKey: family.key,
				providerID: route.providerID,
			},
			family.key,
		);
		// Recorded here as well as in the request hook, which covers the same
		// call: either hook alone has to leave the watcher with the right row,
		// and writing the same target twice is not a change.
		if (!AUXILIARY_KINDS.has(String(event.kind))) {
			recordTarget(event.sessionID, {
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
			// Reuse the route this model request chose. The host's HTTP stack
			// retries the request itself, and choosing a new credential for each
			// retry is what mixed two providers' errors into one attempt.
			let route = boundRoute(event.sessionID, family.key, kind);
			let parkedFallback = false;
			if (!route) {
				const chosen = side
					? chooseSideRoute({ db, family, sessionID: event.sessionID })
					: chooseStickyRoute({
							db,
							family,
							sessionID: event.sessionID,
						});
				if (!chosen) return;
				route = chosen.route;
				parkedFallback = chosen.parkedFallback;
			}
			bindRoute(event.sessionID, family.key, kind, route);

			let request = event.request;
			const url = routedURL(request.url, route.baseURL);
			if (url && url !== request.url) request = new Request(url, request);
			request = await rewriteModel(request, route.modelID);

			const headers = new Headers(request.headers);
			applyAuthToHeaders(headers, route.account.auth);
			request = new Request(request, { headers });

			event.request = request;
			if (!side) {
				announceRoute({
					db,
					// Per row, so one model's switch is not announced as another's:
					// with two models in a session these lines would otherwise
					// alternate for no reason at all.
					key: modelKey(event.sessionID, family.key),
					modelID: family.key,
					next: { alias: route.account.alias, providerID: route.providerID },
					reason: parkedFallback
						? "nothing healthy could answer; trying it anyway"
						: undefined,
				});
				markAccountUsed(db, route.providerID, route.account.alias);
			}
			const tracked = {
				alias: route.account.alias,
				at: now(),
				context: route.context,
				familyKey: family.key,
				providerID: route.providerID,
			};
			byRequest.set(request, tracked);
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
					recordTarget(event.sessionID, {
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

	await ctx.session.hook("http.response", (event) => {
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
			// An answer ends the failover trail for this row: the session stays
			// on this target and a later failure may try the others again.
			if (tracked.familyKey) {
				trailsByModel.delete(modelKey(event.sessionID, tracked.familyKey));
			}
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
		triedFor(event.sessionID, rowKey).add(
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
		// is this row's own list of credentials tried since its last answer, not
		// the host's `event.attempt`: the host never resets that one, so a
		// long-lived session — every failure it ever had, added up — would
		// eventually cross the cap and be cut off from failover for good. Counting
		// per row is what keeps one model's failures from spending another's room,
		// and the row is the model, so it is also the list the user can see.
		const triedNow = triedFor(event.sessionID, rowKey).size;
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
		// just marked limited is skipped by the health check either way.
		clearBoundRoutes(event.sessionID, rowKey);
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
