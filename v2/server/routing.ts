import type { Database } from "bun:sqlite";
import { accountKey } from "../core/accounts";
import { now } from "../core/time";
import type { Account } from "../core/types";
import {
	BALANCER_BASE_URL,
	type FamilyRoute,
	type ModelFamily,
	resolveChain,
	sortRoutes,
} from "./connectors";
import { modelUnavailable } from "./model-availability";
import { servedFor } from "./route-memory";
import {
	enabledAccounts,
	enabledAccountsInOrder,
	healthyAccounts,
	healthyAccountsInOrder,
} from "./selection";
import { usePinFor } from "./use-pin";

export type ChosenRoute = FamilyRoute & { account: Account };

/** This provider's free spelling of the same model, or undefined if it has none. */
function freeVariantOf(route: FamilyRoute): FamilyRoute | undefined {
	const variant = route.freeVariant;
	if (!variant) return undefined;
	return {
		...route,
		available: true,
		baseURL: variant.baseURL,
		context: variant.context,
		free: true,
		modelID: variant.modelID,
		name: variant.name ?? variant.modelID,
		output: variant.output,
	};
}

/**
 * The order a row walks, with the user's pick at its head.
 *
 * `use` is an instruction about where the trail starts, not a filter: the list
 * rotates so the picked provider comes first, the rest follow in the row's own
 * order, and the wrap lands on the true head. A pick that is not in this row
 * (or already first) leaves the order alone; a pick that cannot serve is skipped
 * by the health checks and the walk continues from its place.
 */
function withPickAtHead(db: Database, family: ModelFamily): ModelFamily {
	const pin = usePinFor(db);
	if (!pin) return family;
	const chain = resolveChain(db, family);
	const index = chain.findIndex((route) => route.providerID === pin.providerID);
	if (index <= 0) return family;
	return {
		...family,
		stored: true,
		targets: [...chain.slice(index), ...chain.slice(0, index)],
	};
}

/**
 * The next target able to answer for this row.
 *
 * The credential — not the provider — is what is tried and parked, which is why
 * `exclude` holds credential keys: two credentials on one provider are two
 * chances to answer, and a failure on the first must not write off the second.
 * Limited, disabled, withdrawn and excluded credentials are skipped, which is
 * what makes a retry hop forward instead of repeating the same one.
 *
 * A hand-built row *is* an order of providers, so it is walked as written and
 * each provider's credentials are tried in the balancer's order within it. A row
 * in automatic order has no order of its own, so it follows the credential order
 * itself — the same list the panel shows, which makes `↑ ↓` mean what it looks
 * like it means and lifting a credential above another provider's move it above
 * that provider.
 *
 * Free-only is a property of the credential, so a credential the user keeps no
 * credits on is pointed at its provider's own free spelling of the model when
 * there is one, and skipped when there is not.
 *
 * Nothing here looks at the conversation's size. The balancer reports one large
 * window and compacts the conversation itself, so a request is never held back
 * for being too big for one of the row's targets.
 */
export function chooseRouteForRequest(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
	minContext?: number,
): ChosenRoute | undefined {
	const ordered = withPickAtHead(db, family);
	return ordered.stored
		? walkStoredChain(db, ordered, exclude, false, minContext)
		: walkCredentialOrder(db, ordered, exclude, false, minContext);
}

/** The route to send for one credential, or undefined if free-only blocks it. */
function targetFor(
	db: Database,
	route: FamilyRoute,
	account: Account,
	minContext?: number,
): ChosenRoute | undefined {
	const target =
		route.free === false && account.freeOnly ? freeVariantOf(route) : route;
	if (!target) return undefined;
	// A provider that has refused this exact model will refuse it again until the
	// mark lapses: the catalogue cannot know a plan, so the answer has to. The
	// mark is per pair, which keeps one refused model from hiding the rest of the
	// provider's row.
	if (modelUnavailable(db, target.providerID, target.modelID)) return undefined;
	// A conversation already larger than this target's window cannot be sent
	// there: the provider would reject the whole request. The row reports one
	// large window, so nothing else stops a failover from walking into a
	// smaller sibling of the same model.
	if (
		minContext !== undefined &&
		minContext > 0 &&
		typeof target.context === "number" &&
		target.context > 0 &&
		target.context < minContext
	) {
		return undefined;
	}
	return { ...target, account };
}

function walkStoredChain(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string>,
	includeParked = false,
	minContext?: number,
): ChosenRoute | undefined {
	for (const route of resolveChain(db, family)) {
		if (route.available === false) continue;
		const accounts = includeParked
			? enabledAccounts(db, route.providerID)
			: healthyAccounts(db, route.providerID);
		for (const account of accounts) {
			if (exclude.has(accountKey(route.providerID, account.alias))) continue;
			const chosen = targetFor(db, route, account, minContext);
			if (chosen) return chosen;
		}
	}
	return undefined;
}

function walkCredentialOrder(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string>,
	includeParked = false,
	minContext?: number,
): ChosenRoute | undefined {
	const byProvider = new Map(
		family.targets.map((route) => [route.providerID, route]),
	);
	const accounts = includeParked
		? enabledAccountsInOrder(db)
		: healthyAccountsInOrder(db);
	for (const account of accounts) {
		if (exclude.has(accountKey(account.providerID, account.alias))) continue;
		const route = byProvider.get(account.providerID);
		if (!route || route.available === false) continue;
		const chosen = targetFor(db, route, account, minContext);
		if (chosen) return chosen;
	}
	return undefined;
}

/**
 * The next target for this row, parks included: the last chance when nothing
 * healthy can answer it.
 *
 * A row only ever holds providers that actually offer the model, so a row whose
 * only target is parked has no alternative to protect — the park is the
 * balancer's own guess about the world, and with nothing behind it an attempt
 * beats leaving the call pointed at the stub, which reaches the session as a
 * transport failure it cannot explain.
 */
export function chooseRouteIgnoringParks(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
	minContext?: number,
): ChosenRoute | undefined {
	return family.stored
		? walkStoredChain(db, family, exclude, true, minContext)
		: walkCredentialOrder(db, family, exclude, true, minContext);
}

/**
 * The last target that actually answered this row, when it can still be tried.
 *
 * This is the fail-open answer. Everything else in routing is a prediction about
 * which target *should* serve next — a chain order, a park, a refusal mark, a
 * window comparison — and every one of those can be wrong or stale. The one
 * fact the balancer has is which target last produced an answer, so when nothing
 * else can be chosen that is what a request should go to: a session keeps
 * working on the model it was already running instead of stopping because the
 * plugin's own bookkeeping went bad.
 *
 * It is a target, not a promise. The credential may have run out between then
 * and now, in which case the provider says so in its own words — which is still
 * better than never sending the request at all.
 */
export function chooseLastServed(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
): ChosenRoute | undefined {
	const served = servedFor(db, family.key);
	if (!served) return undefined;
	const routes = family.stored
		? resolveChain(db, family)
		: sortRoutes(family.targets, db);
	// The row may hold the same provider under two ids (a paid and a free
	// spelling); the note names the one that answered, so prefer it and fall back
	// to the provider alone.
	const route =
		routes.find(
			(entry) =>
				entry.providerID === served.providerID &&
				entry.modelID === served.modelID,
		) ?? routes.find((entry) => entry.providerID === served.providerID);
	if (!route) return undefined;
	// The credential that answered last, when it is still enabled and not already
	// spent in this walk; otherwise another credential of the same provider,
	// because the target is the same model and any key left is worth an attempt.
	const accounts = enabledAccounts(db, route.providerID).filter(
		(entry) => !exclude.has(accountKey(entry.providerID, entry.alias)),
	);
	const account =
		accounts.find((entry) => entry.alias === served.alias) ?? accounts[0];
	if (!account) return undefined;
	const target =
		route.free === false && account.freeOnly ? freeVariantOf(route) : route;
	return target ? { ...target, account } : undefined;
}

/**
 * The target with the largest window this row can reach, parks included.
 *
 * Only used when nothing fits the conversation: every other target would be
 * rejected outright by the provider, so the largest window is the only one that
 * might still answer — and it is also the one whose refusal names the real
 * limit, which is more use to the user than a smaller model's.
 */
export function chooseLargestTarget(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
): ChosenRoute | undefined {
	const routes = family.stored
		? resolveChain(db, family)
		: sortRoutes(family.targets, db);
	const candidates = routes.filter((route) => route.available !== false);
	// Largest first, so the first credential of the widest target answers.
	candidates.sort((left, right) => (right.context ?? 0) - (left.context ?? 0));
	for (const route of candidates) {
		for (const account of enabledAccounts(db, route.providerID)) {
			const key = accountKey(route.providerID, account.alias);
			if (exclude.has(key)) continue;
			const target =
				route.free === false && account.freeOnly ? freeVariantOf(route) : route;
			if (!target) continue;
			if (modelUnavailable(db, target.providerID, target.modelID)) continue;
			return { ...target, account };
		}
	}
	return undefined;
}

/**
 * The healthiest target that can still answer this row once its oldest turns
 * are cut away.
 *
 * A target is only a candidate when it is healthy and its window is smaller than
 * the conversation. Anything that could hold the conversation whole was already
 * returned by `chooseRouteForRequest`, so reaching this means every fitting
 * target is spent, marked, or parked. The widest candidate is taken first
 * because it loses the least of the conversation, and a tie falls back to the
 * row's own order.
 *
 * A parked target is deliberately not a candidate. Cutting the conversation is a
 * real cost, and a park is the balancer's belief that a credential is spent; a
 * healthy smaller window is the better purchase than a larger one that is
 * probably going to refuse.
 */
export function chooseTrimTarget(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
	minContext?: number,
): ChosenRoute | undefined {
	if (minContext === undefined || minContext <= 0) return undefined;
	const routes = family.stored
		? resolveChain(db, family)
		: sortRoutes(family.targets, db);
	const candidates = routes
		.filter(
			(route) =>
				route.available !== false &&
				typeof route.context === "number" &&
				route.context > 0 &&
				route.context < minContext,
		)
		.sort((left, right) => (right.context ?? 0) - (left.context ?? 0));
	for (const route of candidates) {
		for (const account of healthyAccounts(db, route.providerID)) {
			if (exclude.has(accountKey(route.providerID, account.alias))) continue;
			const chosen = targetFor(db, route, account);
			if (chosen) return chosen;
		}
	}
	return undefined;
}

/**
 * The ladder a request climbs when its row's first choice did not answer.
 *
 * The rungs go from cheapest to most drastic: a target that fits the
 * conversation, a smaller healthy target that fits once the oldest turns are
 * cut, a parked target that fits, the widest window, the target that last
 * answered, and finally anything at all. `wrap` controls the second pass, where
 * credentials already tried in this walk are offered again — the request hooks
 * want that so a row with one credential still reaches it, while the failover
 * loop does not, because repeating a credential it just saw refuse only burns
 * the attempt cap.
 */
export function chooseFailoverRoute(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
	minContext?: number,
	options: { wrap?: boolean } = {},
): ChosenRoute | undefined {
	const chosen =
		chooseRouteForRequest(db, family, exclude, minContext) ??
		chooseTrimTarget(db, family, exclude, minContext) ??
		chooseRouteIgnoringParks(db, family, exclude, minContext) ??
		chooseLargestTarget(db, family, exclude) ??
		chooseLastServed(db, family, exclude) ??
		chooseRouteAtAnyCost(db, family, exclude);
	if (chosen) return chosen;
	if (options.wrap === false) return undefined;
	return (
		chooseRouteForRequest(db, family, undefined, minContext) ??
		chooseTrimTarget(db, family, undefined, minContext) ??
		chooseRouteIgnoringParks(db, family, undefined, minContext) ??
		chooseLargestTarget(db, family) ??
		chooseLastServed(db, family) ??
		chooseRouteAtAnyCost(db, family)
	);
}

/**
 * The last target this row can reach at all, for a request that must not be left
 * pointed at the stub.
 *
 * `chooseRouteIgnoringParks` still respects the two marks that say "this exact
 * pair cannot work": a model the provider no longer offers, and a pair it has
 * already refused. When every target carries one, there is nothing left to
 * choose from, and the call would go to `balancer.invalid` — a host name that
 * does not resolve, which reaches the session as an unexplainable network
 * failure.
 *
 * At that point an attempt is the only thing that can produce an answer, and it
 * is also the only thing that can produce a refusal in the provider's own words.
 * So this ignores the marks and every park, and returns the row's first target
 * that has an enabled credential, that credential attached.
 */
export function chooseRouteAtAnyCost(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
): ChosenRoute | undefined {
	const ordered = withPickAtHead(db, family);
	const routes = ordered.stored
		? resolveChain(db, ordered)
		: sortRoutes(ordered.targets, db);
	for (const route of routes) {
		for (const account of enabledAccounts(db, route.providerID)) {
			if (exclude.has(accountKey(route.providerID, account.alias))) continue;
			const target =
				route.free === false && account.freeOnly ? freeVariantOf(route) : route;
			if (target) return { ...target, account };
		}
	}
	return undefined;
}

/**
 * Why nothing can serve this row, in the words the user needs to act on.
 *
 * A row that cannot be routed is not a balancer failure: a model may have left
 * every provider that offered it, a price gate may have blocked every one, or
 * every credential may be parked. Saying which of those it is turns "the call
 * failed" into a sentence the user can do something about.
 */
export function describeUnroutable(
	db: Database,
	family: ModelFamily,
): string[] {
	const reasons: string[] = [];
	for (const route of resolveChain(db, family)) {
		const target = `${route.providerID} ${route.modelID}`;
		if (route.available === false) {
			reasons.push(`${target}: the provider no longer offers it`);
			continue;
		}
		if (modelUnavailable(db, route.providerID, route.modelID)) {
			reasons.push(
				`${target}: refused by the provider or blocked by a price gate`,
			);
			continue;
		}
		const accounts = enabledAccounts(db, route.providerID);
		if (accounts.length === 0) {
			reasons.push(`${target}: no enabled credential for ${route.providerID}`);
			continue;
		}
		const parked = accounts.every(
			(account) =>
				account.rateLimitedUntil != null && account.rateLimitedUntil > now(),
		);
		if (parked) {
			const until = Math.max(
				...accounts.map((account) => account.rateLimitedUntil ?? 0),
			);
			reasons.push(
				`${target}: every credential is limited until ${new Date(until).toISOString()}`,
			);
			continue;
		}
		reasons.push(`${target}: no credential could take the request`);
	}
	return reasons.length > 0
		? reasons
		: [`${family.key}: the row has no targets left`];
}

export function chooseRoute(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
	minContext?: number,
): ChosenRoute | undefined {
	return chooseRouteForRequest(db, family, exclude, minContext);
}

/**
 * Whether anything else could answer for this row, ignoring one credential the
 * session has already tried.
 */
export function hasAlternativeRoute(
	db: Database,
	family: ModelFamily,
	excludeKey: string,
	minContext?: number,
) {
	return (
		chooseRoute(db, family, new Set([excludeKey]), minContext) !== undefined
	);
}

/**
 * The catalog URL for a request the stub provider would otherwise send to
 * `balancer.invalid`: keep the call's path suffix and swap the API root.
 */
export function routedURL(
	requestURL: string,
	baseURL: string,
): string | undefined {
	let url: URL;
	try {
		url = new URL(requestURL);
	} catch {
		return undefined;
	}
	if (url.hostname !== new URL(BALANCER_BASE_URL).hostname) return undefined;
	const suffix = url.pathname.replace(/^\/v1(?=\/)/, "");
	return `${baseURL}${suffix}${url.search}`;
}

/**
 * Replace the `model` field of a JSON body with the connector's own id, so the
 * upstream never sees the virtual family name. Anything unparseable is returned
 * untouched: failing the call is better than changing a body we do not
 * understand.
 *
 * `adjust` sees the parsed body first, for the parts of a request that are about
 * the target rather than the model — a thinking level named differently, say.
 */
export async function rewriteModel(
	request: Request,
	modelID: string,
	adjust?: (body: Record<string, unknown>) => void,
): Promise<Request> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) return request;
	let body: unknown;
	try {
		body = JSON.parse(await request.clone().text());
	} catch {
		return request;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return request;
	const record = body as Record<string, unknown>;
	record.model = modelID;
	adjust?.(record);
	return new Request(request.url, {
		body: JSON.stringify(record),
		headers: request.headers,
		method: request.method,
	});
}
