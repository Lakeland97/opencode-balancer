import type { Database } from "bun:sqlite";
import type { Account } from "../core/types";
import {
	BALANCER_BASE_URL,
	type FamilyRoute,
	type ModelFamily,
	sortRoutes,
} from "./connectors";
import { selectHealthyAccount } from "./selection";

export type ChosenRoute = FamilyRoute & { account: Account };

/**
 * The next connector able to answer for this family, in the user's provider
 * priority order. Limited, disabled, and excluded providers are skipped, which
 * is what makes a retry hop connectors instead of repeating the same one.
 */
export function chooseRoute(
	db: Database,
	family: ModelFamily,
	exclude: ReadonlySet<string> = new Set(),
): ChosenRoute | undefined {
	for (const route of sortRoutes(family.routes, db)) {
		if (exclude.has(route.providerID)) continue;
		const account = selectHealthyAccount(db, route.providerID);
		if (!account) continue;
		return { ...route, account };
	}
	return undefined;
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
