import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	type ChainTarget,
	deleteChain,
	getStoredChain,
	moveTarget,
	moveTargetTo,
	saveChain,
} from "../core/chains";
import { readModelLimit } from "../core/context";
import {
	ambiguousModels,
	type ModelCandidate,
	matchModel,
} from "../core/models";
import {
	type FamilyRoute,
	invalidateCatalog,
	loadCatalog,
	type ModelFamily,
	resolveChain,
} from "./connectors";
import { modelUnavailable } from "./model-availability";
import { servedFor } from "./route-memory";
import { enabledAccounts } from "./selection";

const DEFAULT_CHAIN_PACKAGE = "@opencode/ai/providers/openai-compatible";

export type ActionResult =
	| { ok: true; message: string }
	| { ok: false; message: string };

export type RowResolution =
	| { kind: "row"; family: ModelFamily }
	| { kind: "ambiguous"; ties: readonly ModelFamily[] };

/** A query that named the family but not the variant: list, never guess. */
function ambiguousModel(
	query: string,
	providerID: string,
	ties: readonly ModelCandidate[],
): ActionResult {
	return {
		message: [
			`"${query}" matches ${ties.length} ${providerID} models:`,
			...ties.map(
				(model) => `  ${model.modelID}  (${model.name ?? model.modelID})`,
			),
			"Use the exact id.",
		].join("\n"),
		ok: false,
	};
}

/** Resolve what the user typed to a row, by key or by the picker's label. */
export async function findRow(
	ctx: Context,
	db: Database,
	query: string,
): Promise<RowResolution | undefined> {
	const catalog = await loadCatalog(ctx, db);
	const match = matchModel(
		query,
		catalog.families.map((family) => ({
			modelID: family.key,
			name: family.name,
		})),
	);
	if (!match) return undefined;

	const byKey = new Map(catalog.families.map((family) => [family.key, family]));
	const ties = ambiguousModels(match).flatMap((entry) => {
		const family = byKey.get(entry.modelID);
		return family ? [family] : [];
	});
	if (ties.length > 0) return { kind: "ambiguous", ties };

	const family = byKey.get(match.model.modelID);
	return family ? { family, kind: "row" } : undefined;
}

/** Resolve a stored or automatic row by its exact key. */
export async function rowByKey(
	ctx: Context,
	db: Database,
	key: string,
): Promise<ModelFamily | undefined> {
	const catalog = await loadCatalog(ctx, db);
	return catalog.families.find((family) => family.key === key);
}

/** The target list a row routes in, as plain targets ready to store. */
export function rowTargets(db: Database, family: ModelFamily): ChainTarget[] {
	return resolveChain(db, family).map((route) => ({
		baseURL: route.baseURL,
		modelID: route.modelID,
		providerID: route.providerID,
	}));
}

function store(
	db: Database,
	family: ModelFamily,
	targets: ChainTarget[],
): void {
	saveChain(db, {
		familyKey: family.key,
		label: family.name,
		package: family.package,
		targets,
	});
	invalidateCatalog();
}

/**
 * Appends a target the user chose by hand.
 *
 * A target only has to be new: the point of a chain is that each hop can be a
 * different model, so the query is matched against everything the provider
 * routes rather than only this row's family. A provider appears once per row,
 * because that is the row's shape; a *different model* on that provider is a
 * separate row, which is what creating one is for.
 *
 * The wire format is still checked. Routing rewrites the body's `model` field
 * and nothing else, so a request shaped for one package must not reach a
 * provider speaking another.
 */
export async function addTarget(
	ctx: Context,
	db: Database,
	family: ModelFamily,
	providerID: string,
	query: string,
): Promise<ActionResult> {
	const current = rowTargets(db, family);
	if (current.some((target) => target.providerID === providerID)) {
		return {
			message: `${providerID} is already in this chain. Remove it first.`,
			ok: false,
		};
	}

	const list = await ctx.model.list();
	const candidates = list.data.filter(
		(model) =>
			model.providerID === providerID &&
			(!model.type || model.type === "chat") &&
			model.enabled !== false &&
			typeof model.settings?.baseURL === "string",
	);
	const match = matchModel(
		query,
		candidates.map((model) => ({
			modelID: model.modelID,
			name: model.name ?? model.modelID,
		})),
	);
	const ties = ambiguousModels(match);
	if (ties.length > 0) return ambiguousModel(query, providerID, ties);
	const record = match
		? candidates.find((model) => model.modelID === match.model.modelID)
		: undefined;
	if (!record) {
		return {
			message: `No routable ${providerID} model matches "${query}".`,
			ok: false,
		};
	}
	if (
		current.some(
			(target) =>
				target.providerID === providerID && target.modelID === record.modelID,
		)
	) {
		return {
			message: `${providerID} ${record.modelID} is already in this chain.`,
			ok: false,
		};
	}
	if ((record.package ?? "") !== family.package) {
		return {
			message: `${providerID}'s ${record.modelID} speaks ${record.package}, but this row speaks ${family.package}.`,
			ok: false,
		};
	}

	store(db, family, [
		...current,
		{
			baseURL: (record.settings?.baseURL ?? "").replace(/\/+$/, ""),
			modelID: record.modelID,
			providerID,
		},
	]);
	return { message: `Added ${providerID} ${record.modelID}.`, ok: true };
}

/**
 * Start a custom row from one routable model. The row is stored immediately, so
 * it survives even when no connector offers that model as a family, and its key
 * is derived from the model so the picker lists it as `balancer/<key>`.
 */
export async function createChain(
	ctx: Context,
	db: Database,
	providerID: string,
	query: string,
): Promise<ActionResult & { key?: string }> {
	const list = await ctx.model.list();
	const candidates = list.data.filter(
		(model) =>
			model.providerID === providerID &&
			(!model.type || model.type === "chat") &&
			model.enabled !== false &&
			typeof model.settings?.baseURL === "string",
	);
	if (candidates.length === 0) {
		return { message: `No routable models for ${providerID}.`, ok: false };
	}
	const match = matchModel(
		query,
		candidates.map((model) => ({
			modelID: model.modelID,
			name: model.name ?? model.modelID,
		})),
	);
	const ties = ambiguousModels(match);
	if (ties.length > 0) return ambiguousModel(query, providerID, ties);
	const record = match
		? candidates.find((model) => model.modelID === match.model.modelID)
		: undefined;
	if (!record) {
		return {
			message: `No routable ${providerID} model matches "${query}".`,
			ok: false,
		};
	}

	const existing = (await loadCatalog(ctx, db)).families.find((family) =>
		family.targets.some(
			(target) =>
				target.providerID === providerID && target.modelID === record.modelID,
		),
	);
	const key = existing?.key ?? familyKeyFor(record.modelID);
	// Creating a row replaces its whole target list. A stored chain is the
	// user's own configuration, so it is never silently reshaped; an automatic
	// row is just the catalogue's order, and registering it is what `create` is
	// for. Add to a stored row instead.
	if (existing?.stored || getStoredChain(db, key)) {
		return {
			message: `${key} already exists; use its model row to add or edit targets.`,
			ok: false,
		};
	}
	saveChain(db, {
		familyKey: key,
		label: record.name ?? existing?.name ?? record.modelID,
		package: record.package ?? existing?.package ?? DEFAULT_CHAIN_PACKAGE,
		targets: [
			{
				baseURL: (record.settings?.baseURL ?? "").replace(/\/+$/, ""),
				modelID: record.modelID,
				providerID,
			},
		],
	});
	invalidateCatalog();
	return { key, message: `Started ${key} with ${providerID}.`, ok: true };
}

/** A stable, readable row key from a model id. */
function familyKeyFor(modelID: string) {
	return modelID
		.toLowerCase()
		.replace(/[^a-z0-9.]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function removeTarget(
	db: Database,
	family: ModelFamily,
	providerID: string,
): ActionResult {
	const current = rowTargets(db, family);
	const next = current.filter((target) => target.providerID !== providerID);
	if (next.length === current.length) {
		return { message: `${providerID} is not in this chain.`, ok: false };
	}
	if (next.length === 0) {
		return {
			message: "That is the last target; a row needs at least one.",
			ok: false,
		};
	}
	store(db, family, next);
	return { message: `Removed ${providerID} from ${family.key}.`, ok: true };
}

export function shiftTarget(
	db: Database,
	family: ModelFamily,
	providerID: string,
	direction: "up" | "down",
): ActionResult {
	// Moving an automatic row snapshots it first, so the order the user saw is
	// the order they keep editing.
	if (!family.stored) store(db, family, rowTargets(db, family));
	const moved = moveTarget(
		db,
		family.key,
		providerID,
		direction === "up" ? -1 : 1,
	);
	invalidateCatalog();
	return moved
		? { message: `Moved ${providerID} ${direction}.`, ok: true }
		: {
				message: `${providerID} cannot move further ${direction}.`,
				ok: false,
			};
}

/** Moves one target to a position, for a drag rather than a single step. */
export function shiftTargetTo(
	db: Database,
	family: ModelFamily,
	providerID: string,
	to: number,
): ActionResult {
	// The same snapshot as a step, for the same reason: the order a drag lands in
	// has to be the one the user was looking at.
	if (!family.stored) store(db, family, rowTargets(db, family));
	const moved = moveTargetTo(db, family.key, providerID, to);
	invalidateCatalog();
	return moved
		? { message: `Moved ${providerID}.`, ok: true }
		: { message: `${providerID} is already there.`, ok: false };
}

/** Hands a row back to provider priority. Returns false when it was automatic. */
export function resetRow(db: Database, family: ModelFamily): boolean {
	const existed = deleteChain(db, family.key);
	invalidateCatalog();
	return existed;
}

/**
 * The model a target will actually be sent to.
 *
 * `free` is a property of the credential now, so the row shows the free spelling
 * when the credential that would serve is told to spend nothing, and the id it
 * was configured with otherwise. The walk is the one routing makes: down the
 * credentials in the balancer's order, stopping at the first that can answer, so
 * a free-only credential whose provider has no free spelling is passed over
 * exactly as routing passes it over.
 *
 * A park is not a reason to stop saying it. The park is temporary and the row's
 * `state` already reports it; consulting only *healthy* credentials meant the
 * free spelling vanished the moment the key was parked, which is how the panel
 * stopped telling the user that a free model was the one in play.
 */
function resolvedModelID(db: Database, target: FamilyRoute): string {
	if (target.free !== false) return target.modelID;
	for (const account of enabledAccounts(db, target.providerID)) {
		if (!account.freeOnly) return target.modelID;
		if (target.freeVariant) return target.freeVariant.modelID;
	}
	return target.modelID;
}

function targetState(
	db: Database,
	target: { providerID: string; modelID: string; available?: boolean },
	familyKey: string,
): string {
	// The model itself is gone from the connector, or a provider refused this
	// exact pair (a price gate writes the same mark). Either way nothing can be
	// sent here, whoever holds the key.
	if (target.available === false) return "unavailable";
	if (modelUnavailable(db, target.providerID, target.modelID))
		return "unavailable";

	const accounts = enabledAccounts(db, target.providerID);
	if (accounts.length === 0) return "unavailable";

	// "In use" is the provider this row itself last served with. The most
	// recently used credential is global, so a row could otherwise claim a
	// provider that had served some other model while this row was elsewhere.
	// A row with no note of its own has not served since the plugin started,
	// which is better than pointing at whoever happened to answer last.
	const inUse = servedFor(db, familyKey)?.providerID === target.providerID;

	// The provider list says `limited` for as long as a park is recorded, because
	// a park is cleared by the next attempt rather than by its own expiry. A row
	// reading only the clock went back to `available` while the credential above
	// it still said `limited`, which is the contradiction this vocabulary exists
	// to remove. `ready` is the routing question; `parked` is what is reported.
	const ready = accounts.some((account) => account.rateLimitedUntil == null);
	const parked = accounts.some((account) => account.rateLimitedUntil != null);

	const state = ready ? "available" : parked ? "limited" : "unavailable";
	// A parked target that also served is both facts, spelled the way the
	// credential rows spell them, rather than one word hiding the other.
	if (inUse) return state === "available" ? "in use" : `in use, ${state}`;
	return state;
}

export type ChainRow = {
	key: string;
	label: string;
	package: string;
	/**
	 * The tightest window any target of this row reports, or 0 when none does.
	 * The row declares 1M so it can compact on its own schedule; this is what the
	 * request can actually be sent into.
	 */
	context: number;
	/** This model's own limit as typed, or empty when it follows the global one. */
	limit: string;
	stored: boolean;
	targets: Array<{
		providerID: string;
		modelID: string;
		resolved: string;
		state: string;
	}>;
};

/**
 * Every row the panel can show, shaped once. The RPC returns them all and the
 * `/balancer chains` command filters; either way the panel and the terminal are
 * describing the same catalogue with the same state words.
 */
export async function listChainRows(
	ctx: Context,
	db: Database,
): Promise<ChainRow[]> {
	const catalog = await loadCatalog(ctx, db);
	return catalog.families.map((family) => {
		const targets = resolveChain(db, family);
		const windows = targets
			.map((target) => target.context)
			.filter(
				(value): value is number => typeof value === "number" && value > 0,
			);
		return {
			// A row must fit every target it may be sent to, so the smallest
			// window is the one that bounds the conversation.
			context: windows.length > 0 ? Math.min(...windows) : 0,
			key: family.key,
			label: family.name,
			// One value per model: the credential serving it does not change it.
			limit: readModelLimit(db, family.key) ?? "",
			package: family.package,
			stored: Boolean(family.stored),
			targets: targets.map((target) => ({
				modelID: target.modelID,
				providerID: target.providerID,
				resolved: resolvedModelID(db, target),
				state: targetState(db, target, family.key),
			})),
		};
	});
}
