import type { Database } from "bun:sqlite";
import { isFreeOnly, listProviderPriority } from "../core/priority";
import type { Account } from "../core/types";
import {
	BALANCER_BASE_URL,
	type FamilyRoute,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import { selectHealthyAccount } from "./selection";

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

/** Whether the user has switched this provider off in the balancer. */
export function isProviderEnabled(db: Database, providerID: string): boolean {
	const entry = listProviderPriority(db).find(
		(row) => row.providerID === providerID,
	);
	return entry ? entry.enabled : true;
}

/** Rough prompt size, used only when the host will not compact for us. */
export function estimateTokens(body: string): number {
	return Math.ceil(body.length / 4);
}

/**
 * The next target able to answer for this row, in chain order. Limited,
 * disabled, withdrawn, and excluded targets are skipped, which is what makes a
 * retry hop connectors instead of repeating the same one.
 *
 * `body` is only consulted when `guardOverflow` is set: without automatic
 * compaction nothing else stops a conversation outgrowing a small target.
 */
export function chooseRouteForRequest(
	db: Database,
	family: ModelFamily,
	body: string | undefined,
	options: {
		guardOverflow: boolean;
		exclude?: ReadonlySet<string>;
	},
): ChosenRoute | undefined {
	const tokens = options.guardOverflow && body ? estimateTokens(body) : 0;

	for (const route of resolveChain(db, family)) {
		if (options.exclude?.has(route.providerID)) continue;
		if (route.available === false) continue;
		if (!isProviderEnabled(db, route.providerID)) continue;
		// A provider whose credits the user does not top up must not be handed a
		// paid model just because the family matched by name. Its own free
		// spelling of the model takes over when it has one.
		const target =
			route.free === false && isFreeOnly(db, route.providerID)
				? freeVariantOf(route)
				: route;
		if (!target) continue;

		if (target.context && tokens > 0 && tokens > target.context) continue;
		const account = selectHealthyAccount(db, route.providerID);
		if (!account) continue;
		return { ...target, account };
	}
	return undefined;
}

/** The route the next request would take, without a prompt-size guard. */
export function chooseRoute(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
): ChosenRoute | undefined {
	return chooseRouteForRequest(db, family, undefined, {
		exclude,
		guardOverflow: false,
	});
}

export function hasAlternativeRoute(
	db: Database,
	family: ModelFamily,
	excludeProviderID: string,
) {
	return chooseRoute(db, family, new Set([excludeProviderID])) !== undefined;
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
