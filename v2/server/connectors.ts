import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import { listAccounts } from "../core/accounts";
import { listStoredChains } from "../core/chains";
import {
	type CompactionBuffer,
	declaredContext,
	rowWindow,
} from "../core/context";
import { modelFamily, normalizeModel } from "../core/models";
import { listProviderPriority } from "../core/priority";
import { readCompactionBuffer } from "./compaction-config";

/** The provider this plugin registers; sessions pin it and never change. */
export const BALANCER_PROVIDER_ID = "balancer";
/** Never reached: every routed request is rewritten to a real connector first. */
export const BALANCER_BASE_URL = "https://balancer.invalid/v1";
/** The wire format the stub provider itself speaks. */
const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible";

type ModelRecord = Awaited<
	ReturnType<Context["model"]["list"]>
>["data"][number];

export type FamilyRoute = {
	providerID: string;
	modelID: string;
	/** The provider's API root, already normalised without a trailing slash. */
	baseURL: string;
	package: string;
	/** The model's own window, used to size the row. */
	context?: number;
	output?: number;
	/** False when the connector no longer offers this model. */
	available?: boolean;
};

export type ModelFamily = {
	/** Stable id shown to the user, e.g. `deepseek-v4.1-flash`. */
	key: string;
	/** Label from the connector that spells the family canonically. */
	name: string;
	package: string;
	routes: readonly FamilyRoute[];
	/** True when the user has taken over this row's order. */
	stored?: boolean;
	/** The effective order: the stored chain, or the automatic routes. */
	targets: readonly FamilyRoute[];
	/** The smallest window across the targets, which every hop must fit. */
	window?: { context: number; output: number };
};

type Catalog = {
	families: readonly ModelFamily[];
	/** The route used as the template when cloning a model into the stub provider. */
	sources: ReadonlyMap<string, ModelRecord>;
};

const CACHE_MS = 30_000;
let cached: { at: number; catalog: Catalog } | undefined;

export function invalidateCatalog() {
	cached = undefined;
}

function stripTrailingSlash(value: string) {
	return value.replace(/\/+$/, "");
}

/** Short name for a wire format, e.g. `anthropic` from its package. */
function packageTag(pkg: string) {
	return (pkg.split("/").pop() ?? pkg).replace(/-compatible$/, "");
}

/** Distinguishes rows that exist in more than one wire format. */
function labelSuffix(pkg: string) {
	return pkg === DEFAULT_PACKAGE ? "" : ` (${packageTag(pkg)})`;
}

/**
 * Groups every connector's models into families, so
 * `deepseek/deepseek-v4.1-flash` and `deepseek-v4.1-flash` collapse into one
 * picker row that can route to either connector.
 *
 * A family never mixes wire formats: routing rewrites only the body's `model`
 * field, so a request shape built for one package must not reach a provider
 * speaking another. Families that exist in two formats become two rows.
 *
 * Only providers the balancer has accounts for are connectors: anything else is
 * somebody else's to bill.
 */
export async function loadCatalog(
	ctx: Context,
	db: Database,
): Promise<Catalog> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.catalog;

	const connectorIDs = new Set(
		listAccounts(db).map((account) => account.providerID),
	);
	const models = await ctx.model.list();

	const groups = new Map<
		string,
		{
			family: string;
			label: string;
			/** Higher is a more canonical spelling of the family. */
			score: number;
			package: string;
			routes: FamilyRoute[];
			source?: ModelRecord;
		}
	>();

	for (const model of models.data) {
		const providerID = model.providerID;
		if (providerID === BALANCER_PROVIDER_ID) continue;
		if (!connectorIDs.has(providerID)) continue;
		if (model.type && model.type !== "chat") continue;
		if (model.enabled === false) continue;

		const baseURL = model.settings?.baseURL;
		if (typeof baseURL !== "string") continue;

		const family = modelFamily(model.modelID);
		if (!family) continue;

		const pkg = model.package ?? "";
		const tagged = pkg !== DEFAULT_PACKAGE;
		const key = tagged ? `${family}-${packageTag(pkg)}` : family;
		const group = groups.get(key) ?? {
			family,
			label: model.name ?? model.modelID,
			package: pkg,
			routes: [],
			score: -1,
		};

		const route: FamilyRoute = {
			available: true,
			baseURL: stripTrailingSlash(baseURL),
			context: model.limit?.context,
			modelID: model.modelID,
			output: model.limit?.output,
			package: pkg,
			providerID,
		};

		// Prefer the untagged spelling when one connector offers both.
		const exact = normalizeModel(route.modelID) === family;
		const taggedRoute = group.routes.findIndex(
			(entry) => entry.providerID === providerID,
		);
		if (taggedRoute >= 0) {
			if (exact) group.routes[taggedRoute] = route;
		} else {
			group.routes.push(route);
		}

		// The row reads like the connector that spells both the id and the label
		// without a build tag, never like whichever provider was listed first.
		const name = model.name ?? model.modelID;
		const score =
			(normalizeModel(route.modelID) === family ? 2 : 0) +
			(normalizeModel(name) === family ? 1 : 0);
		if (!group.source || score > group.score) {
			group.label = name;
			group.score = score;
			group.source = model;
		}

		groups.set(key, group);
	}

	const families: ModelFamily[] = [];
	const sources = new Map<string, ModelRecord>();
	for (const [key, group] of groups) {
		families.push({
			key,
			name: `${group.label}${labelSuffix(group.package)}`,
			package: group.package,
			routes: group.routes,
			targets: group.routes,
			window: rowWindow(group.routes),
		});
		if (group.source) sources.set(key, group.source);
	}

	// A stored chain wins over the automatic order, and keeps the row alive even
	// when no connector offers that family any more.
	const byRef = new Map<string, ModelRecord>();
	for (const model of models.data) {
		byRef.set(`${model.providerID}:${model.modelID}`, model);
	}

	for (const chain of listStoredChains(db)) {
		if (chain.targets.length === 0) continue;
		const targets: FamilyRoute[] = chain.targets.map((target) => {
			const record = byRef.get(`${target.providerID}:${target.modelID}`);
			return {
				available: Boolean(record),
				baseURL: stripTrailingSlash(target.baseURL),
				context: record?.limit?.context,
				modelID: target.modelID,
				output: record?.limit?.output,
				package: chain.package,
				providerID: target.providerID,
			};
		});
		const window = rowWindow(targets);
		const name = `${chain.label}${labelSuffix(chain.package)}`;
		const existing = families.find((family) => family.key === chain.familyKey);

		if (existing) {
			existing.name = name;
			existing.package = chain.package;
			existing.stored = true;
			existing.targets = targets;
			existing.window = window;
			continue;
		}

		families.push({
			key: chain.familyKey,
			name,
			package: chain.package,
			routes: [],
			stored: true,
			targets,
			window,
		});
		const head = byRef.get(`${targets[0].providerID}:${targets[0].modelID}`);
		if (head) sources.set(chain.familyKey, head);
	}

	const catalog = { families, sources };
	cached = { at: Date.now(), catalog };
	return catalog;
}

function priorityOrder(db: Database): Map<string, number> {
	return new Map(
		listProviderPriority(db).map((entry) => [entry.providerID, entry.position]),
	);
}

/** The order a row routes in: a stored chain as written, or provider priority. */
export function resolveChain(db: Database, family: ModelFamily): FamilyRoute[] {
	return family.stored
		? family.targets.slice()
		: sortRoutes(family.targets, db);
}

/** Sort routes by the user's provider priority, then by name. */
export function sortRoutes(
	routes: readonly FamilyRoute[],
	db: Database,
): FamilyRoute[] {
	const order = priorityOrder(db);
	return routes.slice().sort((a, b) => {
		const left = order.get(a.providerID) ?? Number.MAX_SAFE_INTEGER;
		const right = order.get(b.providerID) ?? Number.MAX_SAFE_INTEGER;
		return left === right
			? a.providerID.localeCompare(b.providerID)
			: left - right;
	});
}

/**
 * Declares the balancer provider: one virtual model per family, named so the
 * picker reads as a single choice instead of one row per connector.
 */
export async function registerBalancerProvider({
	ctx,
	db,
	buffer = readCompactionBuffer(),
}: {
	ctx: Context;
	db: Database;
	buffer?: CompactionBuffer;
}) {
	const catalog = await loadCatalog(ctx, db);
	if (catalog.families.length === 0) return;

	await ctx.provider.transform((editor) => {
		const models = catalog.families.map((family) => {
			const source = catalog.sources.get(family.key);
			const window = family.window;
			return {
				...(source ?? {}),
				id: family.key,
				// The window is the smallest target's, declared so the host's
				// buffer applies to that real limit instead of a fraction of it.
				...(window
					? {
							limit: {
								context: declaredContext(window.context, buffer),
								...(window.output > 0 ? { output: window.output } : {}),
							},
						}
					: {}),
				modelID: family.key,
				name: `Balancer · ${family.name}`,
				package: family.package,
				providerID: BALANCER_PROVIDER_ID,
				settings: {
					...(source?.settings ?? {}),
					apiKey: "balancer",
					baseURL: BALANCER_BASE_URL,
				},
			};
		});

		editor.add({
			info: {
				activation: "enabled",
				id: BALANCER_PROVIDER_ID,
				name: "Balancer",
				package: DEFAULT_PACKAGE,
				settings: {
					apiKey: "balancer",
					baseURL: BALANCER_BASE_URL,
					provider: BALANCER_PROVIDER_ID,
				},
			},
			models,
		} as never);
	});
}
