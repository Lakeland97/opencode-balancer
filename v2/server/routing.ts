import type { Database } from "bun:sqlite";
import { accountKey } from "../core/accounts";
import type { Account } from "../core/types";
import {
	BALANCER_BASE_URL,
	type FamilyRoute,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import {
	enabledAccounts,
	enabledAccountsInOrder,
	healthyAccounts,
	healthyAccountsInOrder,
} from "./selection";

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
		output: variant.output,
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
	return family.stored
		? walkStoredChain(db, family, exclude, false, minContext)
		: walkCredentialOrder(db, family, exclude, false, minContext);
}

/** The route to send for one credential, or undefined if free-only blocks it. */
function targetFor(
	route: FamilyRoute,
	account: Account,
	minContext?: number,
): ChosenRoute | undefined {
	const target =
		route.free === false && account.freeOnly ? freeVariantOf(route) : route;
	if (!target) return undefined;
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
			const chosen = targetFor(route, account, minContext);
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
		const chosen = targetFor(route, account, minContext);
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

/** The route the next request would take for this row. */
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
 */
export async function rewriteModel(
	request: Request,
	modelID: string,
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
	if (record.model === modelID) return request;
	record.model = modelID;
	return new Request(request.url, {
		body: JSON.stringify(record),
		headers: request.headers,
		method: request.method,
	});
}
