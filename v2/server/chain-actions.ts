import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	type ChainTarget,
	deleteChain,
	moveTarget,
	saveChain,
} from "../core/chains";
import { matchModel } from "../core/models";
import {
	invalidateCatalog,
	loadCatalog,
	type ModelFamily,
	resolveChain,
} from "./connectors";

const DEFAULT_CHAIN_PACKAGE = "@opencode/ai/providers/openai-compatible";

export type ActionResult =
	| { ok: true; message: string }
	| { ok: false; message: string };

/** Resolve what the user typed to a row, by key or by the picker's label. */
export async function findRow(
	ctx: Context,
	db: Database,
	query: string,
): Promise<ModelFamily | undefined> {
	const catalog = await loadCatalog(ctx, db);
	const match = matchModel(
		query,
		catalog.families.map((family) => ({
			modelID: family.key,
			name: family.name,
		})),
	);
	return match
		? catalog.families.find((family) => family.key === match.model.modelID)
		: undefined;
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
 * Appends a target the user chose by hand. Only models the provider actually
 * routes and that speak the row's wire format are accepted.
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
	const record = match
		? candidates.find((model) => model.modelID === match.model.modelID)
		: undefined;
	if (!record) {
		return {
			message: `No routable ${providerID} model matches "${query}".`,
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

/** Hands a row back to provider priority. Returns false when it was automatic. */
export function resetRow(db: Database, family: ModelFamily): boolean {
	const existed = deleteChain(db, family.key);
	invalidateCatalog();
	return existed;
}
