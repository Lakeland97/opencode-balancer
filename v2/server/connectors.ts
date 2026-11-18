import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import { listAccounts } from "../core/accounts";
import { listStoredChains } from "../core/chains";
import { DECLARED_CONTEXT } from "../core/context";
import { isFreeModel, modelFamily, normalizeModel } from "../core/models";
import { providerOrder } from "../core/priority";
import {
	cachedRemoteModels,
	type RemoteModel,
	refreshRemoteModels,
} from "./remote-models";
import { canonicalVariants, type Variant } from "./variants";

/** The provider this plugin registers; sessions pin it and never change. */
export const BALANCER_PROVIDER_ID = "balancer";
/** Never reached: every routed request is rewritten to a real connector first. */
export const BALANCER_BASE_URL = "https://balancer.invalid/v1";
/** The wire format the stub provider itself speaks. */
const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible";
/**
 * The answer cap a row declares when none of its targets reported one.
 *
 * The host requires `limit.output` on every model it encodes and fails the
 * whole model list when it is missing. This is the conservative figure the
 * catalogues that do report one bottom out near, so it caps an answer without
 * pretending the provider promised more.
 */
const DEFAULT_DECLARED_OUTPUT = 32_000;

type ModelRecord = Awaited<
	ReturnType<Context["model"]["list"]>
>["data"][number];

export type FamilyRoute = {
	providerID: string;
	modelID: string;
	/**
	 * The connector's own display name for this model, when it published one.
	 *
	 * Ids repeat across a row — six providers spell the same weights
	 * `deepseek-v4.1-flash` — while the names say what each actually is:
	 * "DeepSeek V4.1 Flash 1017", "… Fast", "… Free". The panel lists the name so
	 * the rows can be told apart; the id stays beside it because that is what
	 * the provider is actually asked for.
	 */
	name?: string;
	/** The provider's API root, already normalised without a trailing slash. */
	baseURL: string;
	package: string;
	/** The model's own window, which clamps the share it is compacted at. */
	context?: number;
	output?: number;
	/** False when the connector no longer offers this model. */
	available?: boolean;
	/** True when the model costs nothing, which free-only providers require. */
	free?: boolean;
	/** This connector's own thinking levels, as it named them. */
	variants?: readonly Variant[];
	/** This provider's free spelling of the same model, when it offers one. */
	freeVariant?: {
		baseURL: string;
		context?: number;
		modelID: string;
		/** The provider's own name for that free spelling, when it published one. */
		name?: string;
		output?: number;
	};
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
	/**
	 * One thinking ladder for the row, merged from every target's own names.
	 * Declared to the host so the picker offers every level some target has;
	 * a target missing one gets the nearest rung it does have when routed.
	 */
	variants?: readonly Variant[];
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

/** The family a model belongs to once a free marker is set aside. */
function freeBase(modelID: string) {
	return modelFamily(normalizeModel(modelID.replace(/([-_:])free$/i, "")));
}

/** Distinguishes rows that exist in more than one wire format. */
function labelSuffix(pkg: string) {
	return pkg === DEFAULT_PACKAGE ? "" : ` (${packageTag(pkg)})`;
}

/**
 * Whether a model's own id says it bills, and which way: `hy3-paid` says paid,
 * `…-free` says free, and an id that says nothing says nothing.
 *
 * This is the one thing a matching *title* must not merge away. Two providers
 * calling the same weights `Hy3` is a reason to treat them as one row; one
 * calling its spelling `hy3-paid` and the other not is a reason not to, because
 * the paid one can spend and the free one must not.
 */
function priceTag(modelID: string): string | undefined {
	const match = /(?:^|[/:_.-])(paid|free)(?=$|[/:_.-])/i.exec(
		normalizeModel(modelID),
	);
	return match?.[1]?.toLowerCase();
}

/** The price tags a whole row's targets carry, as a comparable set. */
function rowPriceTags(routes: readonly FamilyRoute[]) {
	return [
		...new Set(
			routes
				.map((route) => priceTag(route.modelID))
				.filter((tag): tag is string => tag !== undefined),
		),
	]
		.sort()
		.join(",");
}

type Group = {
	family: string;
	label: string;
	/** Higher is a more canonical spelling of the family. */
	score: number;
	package: string;
	routes: FamilyRoute[];
	source?: ModelRecord;
};

/**
 * One row per model, matched on every vector available rather than on the id
 * alone.
 *
 * Providers name the same model in ways no single spelling survives: a version
 * with a hyphen or a dot, a namespace, a build tag, or a title that drops the
 * build number the id keeps (`meta/muse-wonder-1.0` against `muse-wonder`, both
 * called `Muse Wonder`). Matching the id alone left two picker rows with one
 * name, and a model that could not fail over between the halves of itself.
 *
 * So a group also merges with an earlier one when the titles agree and nothing
 * says they are different things: the same wire format, and the same answer to
 * "does this bill?" — a price marker is a claim about money, and merging across
 * it would let a free row spend.
 *
 * The earlier key wins, which keeps the spelling the picker already showed.
 */
function mergeByTitle(groups: Map<string, Group>) {
	const kept = new Map<string, Group>();
	const alias = new Map<string, string>();
	for (const [key, group] of groups) {
		const title = normalizeModel(group.label);
		const price = rowPriceTags(group.routes);
		let target: string | undefined;
		for (const [candidateKey, candidate] of kept) {
			if (candidate.package !== group.package) continue;
			if (normalizeModel(candidate.label) !== title) continue;
			if (rowPriceTags(candidate.routes) !== price) continue;
			target = candidateKey;
			break;
		}
		if (target === undefined) {
			kept.set(key, group);
			alias.set(key, key);
			continue;
		}
		const existing = kept.get(target);
		if (!existing) {
			kept.set(key, group);
			continue;
		}
		for (const route of group.routes) {
			// Two spellings of the same id from one provider are one target; the
			// one that spells the family exactly is the one kept, as above.
			const same = existing.routes.findIndex(
				(entry) => entry.providerID === route.providerID,
			);
			if (same < 0) {
				existing.routes.push(route);
				continue;
			}
			if (
				normalizeModel(route.modelID) === existing.family &&
				normalizeModel(existing.routes[same].modelID) !== existing.family
			) {
				existing.routes[same] = route;
			}
		}
		if (group.score > existing.score) {
			existing.label = group.label;
			existing.score = group.score;
			existing.source = group.source;
		}
		alias.set(key, target);
	}
	return { alias, groups: kept };
}

/**
 * Give rows that still share a title a title of their own.
 *
 * Two rows matching every vector but the price — `Hy3` and `Hy3 (paid)` — are
 * real choices, and the picker has to say which is which. The word that tells
 * them apart is whatever a key adds past the words every key in the group
 * shares; the key that adds nothing keeps the plain title.
 */
function distinguishTitles(groups: Map<string, Group>) {
	const byTitle = new Map<string, string[]>();
	for (const [key, group] of groups) {
		const title = `${normalizeModel(group.label)}|${group.package}`;
		const keys = byTitle.get(title) ?? [];
		keys.push(key);
		byTitle.set(title, keys);
	}
	for (const keys of byTitle.values()) {
		if (keys.length < 2) continue;
		const words = keys.map((key) => modelFamily(key).split("-"));
		let shared = 0;
		while (words.every((list) => list[shared] === words[0]?.[shared])) {
			shared += 1;
			if (words.every((list) => list.length <= shared)) break;
		}
		for (const [index, key] of keys.entries()) {
			const note = (words[index] ?? []).slice(shared).join(" ");
			const group = groups.get(key);
			if (!group || note === "") continue;
			group.label = `${group.label} (${note})`;
		}
	}
}

/**
 * The output any hop of this row can hold. The declared output is the smallest
 * the row may be sent, so every target can answer it.
 */
function rowOutput(targets: readonly FamilyRoute[]): number {
	const outputs = targets
		.map((target) => target.output)
		.filter((value): value is number => typeof value === "number" && value > 0);
	return outputs.length > 0 ? Math.min(...outputs) : 0;
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

	// What each connector itself publishes, when it publishes anything. The
	// host's list is a snapshot of `opencode.json`, which is why a provider that
	// adds a model stayed invisible until somebody edited the file. A catalogue
	// read here is cached and never awaited, so a slow provider cannot hold the
	// catalogue open; the entries it adds are real models of that provider, with
	// the window the provider itself reports.
	const remote = new Map<string, RemoteModel[]>();
	for (const model of models.data) {
		if (!connectorIDs.has(model.providerID)) continue;
		const baseURL = model.settings?.baseURL;
		if (typeof baseURL !== "string") continue;
		if (remote.has(model.providerID)) continue;
		const listed = cachedRemoteModels(
			db,
			model.providerID,
			baseURL.replace(/\/+$/, ""),
		);
		if (listed.length > 0) remote.set(model.providerID, [...listed]);
	}

	// A provider often offers the same model twice, once paid and once with a
	// free marker. Which one is sent is a per-credential decision, so the row
	// carries the free spelling alongside the paid one and routing picks between
	// them; a credential told to spend nothing is pointed at the sibling.
	const freeSiblings = new Map<string, ModelRecord>();
	for (const model of models.data) {
		if (!connectorIDs.has(model.providerID)) continue;
		if (typeof model.settings?.baseURL !== "string") continue;
		if (!isFreeModel({ cost: model.cost, modelID: model.modelID })) continue;
		const base = freeBase(model.modelID);
		if (!base || base === modelFamily(model.modelID)) continue;
		freeSiblings.set(
			`${model.providerID}:${base}:${model.package ?? ""}`,
			model,
		);
	}

	const groups = new Map<string, Group>();

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

		const free = isFreeModel({ cost: model.cost, modelID: model.modelID });
		const sibling = free
			? undefined
			: freeSiblings.get(`${providerID}:${family}:${pkg}`);
		const route: FamilyRoute = {
			available: true,
			baseURL: stripTrailingSlash(baseURL),
			context: model.limit?.context,
			free,
			...(sibling && typeof sibling.settings?.baseURL === "string"
				? {
						freeVariant: {
							baseURL: stripTrailingSlash(sibling.settings.baseURL),
							context: sibling.limit?.context,
							modelID: sibling.modelID,
							name: sibling.name ?? sibling.modelID,
							output: sibling.limit?.output,
						},
					}
				: {}),
			modelID: model.modelID,
			name: model.name ?? model.modelID,
			output: model.limit?.output,
			package: pkg,
			providerID,
			variants: (model.variants ?? []) as Variant[],
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

	// A model the provider publishes but `opencode.json` does not mention. It is
	// the provider's own answer, so it is routable: the baseURL comes from a
	// sibling record of the same provider, and the window is the provider's own.
	for (const [providerID, listed] of remote) {
		const sibling =
			models.data.find(
				(model) =>
					model.providerID === providerID &&
					!model.type &&
					typeof model.settings?.baseURL === "string",
			) ??
			models.data.find(
				(model) =>
					model.providerID === providerID &&
					model.type === "chat" &&
					typeof model.settings?.baseURL === "string",
			);
		if (!sibling) continue;
		const baseURL = String(sibling.settings?.baseURL);
		const pkg = sibling.package ?? DEFAULT_PACKAGE;

		for (const entry of listed) {
			if (!isChatCatalogueEntry(entry.id)) continue;
			const family = modelFamily(entry.id);
			if (!family) continue;
			const tagged = pkg !== DEFAULT_PACKAGE;
			const key = tagged ? `${family}-${packageTag(pkg)}` : family;
			const group = groups.get(key) ?? {
				family,
				label: entry.name ?? entry.id,
				package: pkg,
				routes: [],
				score: -1,
			};
			// The host's declaration wins where both exist: it is the one the
			// picker, the limits and any user edit already point at. Where the
			// provider lists the same family twice with different build tags,
			// the row keeps the one whose id spells the family exactly.
			const same = group.routes.findIndex(
				(route) => route.providerID === providerID,
			);
			if (same >= 0) {
				const current = group.routes[same];
				const exact = normalizeModel(entry.id) === family;
				const currentExact = normalizeModel(current.modelID) === family;
				if (currentExact && !exact) {
					groups.set(key, group);
					continue;
				}
				group.routes[same] = {
					...current,
					baseURL: stripTrailingSlash(baseURL),
					context: entry.context ?? current.context,
					modelID: entry.id,
					name: entry.name ?? current.name ?? entry.id,
					output: entry.output ?? current.output,
				};
				groups.set(key, group);
				continue;
			}
			group.routes.push({
				available: true,
				baseURL: stripTrailingSlash(baseURL),
				context: entry.context,
				free: /(^|[/:_-])free$/i.test(entry.id),
				modelID: entry.id,
				name: entry.name ?? entry.id,
				output: entry.output,
				package: pkg,
				providerID,
				variants: [],
			});
			group.routes.sort(paidFirst);
			groups.set(key, group);
		}
	}

	// Every id spelling has been grouped; now merge the groups that are the one
	// model under different names, and tell apart the ones that stay.
	const merged = mergeByTitle(groups);
	distinguishTitles(merged.groups);

	const families: ModelFamily[] = [];
	const sources = new Map<string, ModelRecord>();
	for (const [key, group] of merged.groups) {
		families.push({
			key,
			name: `${group.label}${labelSuffix(group.package)}`,
			package: group.package,
			routes: group.routes,
			targets: group.routes,
			// The picker offers one ladder for the row. Merging it here means a
			// level `saygm` has but `cline-pass` spells differently is still
			// selectable, and routing translates it target by target.
			variants: canonicalVariants(
				group.routes.map((route) => [...(route.variants ?? [])]),
			),
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
			// The stored id may be paid while the credential serving it is told to
			// spend nothing, in which case the provider's free spelling is what is
			// sent. Carry it on the target so routing can swap it in.
			const family = modelFamily(normalizeModel(target.modelID));
			const sibling = family
				? freeSiblings.get(
						`${target.providerID}:${family}:${record?.package ?? ""}`,
					)
				: undefined;
			return {
				available: Boolean(record),
				baseURL: stripTrailingSlash(target.baseURL),
				context: record?.limit?.context,
				free: record
					? isFreeModel({ cost: record.cost, modelID: target.modelID })
					: undefined,
				...(sibling && typeof sibling.settings?.baseURL === "string"
					? {
							freeVariant: {
								baseURL: stripTrailingSlash(sibling.settings.baseURL),
								context: sibling.limit?.context,
								modelID: sibling.modelID,
								name: sibling.name ?? sibling.modelID,
								output: sibling.limit?.output,
							},
						}
					: {}),
				modelID: target.modelID,
				name: record?.name ?? target.modelID,
				output: record?.limit?.output,
				package: chain.package,
				providerID: target.providerID,
				variants: (record?.variants ?? []) as Variant[],
			};
		});
		const name = `${chain.label}${labelSuffix(chain.package)}`;
		// A chain stored before a spelling was folded still names the family by
		// its old key (`claude-opus-4-8`); the row it belongs to now lives under
		// the folded one (`claude-opus-4.8`), so follow the alias rather than
		// listing the same model twice.
		const rowKey = merged.alias.get(chain.familyKey) ?? chain.familyKey;
		const existing = families.find((family) => family.key === rowKey);
		const variants = canonicalVariants(
			targets.map((target) => [...(target.variants ?? [])]),
		);

		if (existing) {
			existing.name = name;
			existing.package = chain.package;
			existing.stored = true;
			existing.targets = targets;
			existing.variants = variants;
			continue;
		}

		families.push({
			key: chain.familyKey,
			name,
			package: chain.package,
			routes: [],
			stored: true,
			targets,
			variants,
		});
		const head = byRef.get(`${targets[0].providerID}:${targets[0].modelID}`);
		if (head) sources.set(chain.familyKey, head);
	}

	const catalog = { families, sources };
	cached = { at: Date.now(), catalog };
	return catalog;
}

/**
 * Whether a catalogue entry is a chat model this balancer can send to.
 *
 * A provider's `/models` lists everything it sells, including batch endpoints,
 * embeddings, speech and image generation. A row is a chat model and routing
 * rewrites a chat body, so a non-chat entry would be a row that can only fail.
 */
export function isChatCatalogueEntry(id: string) {
	if (/:(batch|embedding|embeddings)$/i.test(id)) return false;
	return !/(^|[/:_-])(embed|embedding|embeddings|whisper|tts|audio|speech|rerank|moderation|image-gen|video)([/:_-]|$)/i.test(
		id,
	);
}

/** Paid spelling before the free one, so a family keeps the model it bills for. */
function paidFirst(left: { modelID: string }, right: { modelID: string }) {
	const free = (model: { modelID: string }) =>
		/(^|[/:_-])free$/i.test(model.modelID);
	return Number(free(left)) - Number(free(right));
}

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
	const order = providerOrder(db);
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
/** What the declared models are built from; replaced whenever the host reloads. */
let declarations: { catalog: Catalog } | undefined;

/** The balancer's virtual models, one per family, at the window each settles on. */
function declaredModels(catalog: Catalog) {
	return catalog.families.map((family) => {
		const source = catalog.sources.get(family.key);
		const output = rowOutput(family.targets);
		return {
			// A stored row outlives its family, so it may have no source
			// record at all; the host sorts on these fields and crashes
			// without them.
			...(source ?? {
				capabilities: { input: ["text"], output: ["text"], tools: true },
				cost: [],
				enabled: true,
				status: "active" as const,
				time: { released: 0 },
				variants: [],
			}),
			// The host filters the picker on `family` and `type`. A source record
			// that carries neither is otherwise dropped on the floor, which made
			// every open-design-only row vanish from the picker while the provider
			// itself was serving. The row is a chat model by construction, and the
			// family has to be its own key: a shared label makes the host keep one
			// row per family and drop the rest.
			family: source?.family ?? family.key,
			id: family.key,
			// Every balancer model claims the same large window. The host trims
			// a conversation when it reaches what it was told the model holds,
			// so declaring the real window would hand it the timing; the
			// balancer trims on its own threshold instead. The output stays
			// real, because it caps one answer rather than the conversation.
			limit: {
				context: DECLARED_CONTEXT,
				// The host requires this key on every model it encodes, so a row
				// whose targets never reported an answer cap still has to carry
				// one. A conservative figure is better than a missing field: the
				// host refused the whole model list when it was absent.
				output: output > 0 ? output : DEFAULT_DECLARED_OUTPUT,
			},
			modelID: family.key,
			name: `Balancer · ${family.name}`,
			package: family.package,
			providerID: BALANCER_PROVIDER_ID,
			settings: {
				...(source?.settings ?? {}),
				apiKey: "balancer",
				baseURL: BALANCER_BASE_URL,
			},
			// A source record from a provider that leaves `type` unset inherits
			// that omission. The host then keeps the model out of the picker,
			// which is how half a provider's rows disappeared from the list. A
			// family only ever holds chat routes (the catalogue drops anything
			// else), so declaring it is the correct type, not a guess.
			type: "chat",
			// One ladder for the whole row: the union of every target's rungs, so
			// the picker never offers a level the row cannot send anywhere, and
			// never hides one some target supports. Routing maps the chosen level
			// onto the target it lands on.
			variants: family.variants ?? source?.variants ?? [],
		};
	});
}

export async function registerBalancerProvider({
	ctx,
	db,
}: {
	ctx: Context;
	db: Database;
}) {
	// Accounts were just imported, so a catalogue cached before that import is
	// missing every provider it added. Reading it again is what makes a provider
	// that arrived while the plugin was loading visible from the first request.
	invalidateCatalog();
	// What the providers publish about themselves, before the first read: the
	// startup catalogue is the one the picker shows, and a model added on the
	// provider's side should be in it. This is the only await on the network, it
	// is bounded, and a provider that does not answer costs nothing but its own
	// declared models.
	const connectorList = await ctx.model.list();
	const sources = new Map<string, string>();
	for (const model of connectorList.data) {
		if (model.providerID === BALANCER_PROVIDER_ID) continue;
		if (typeof model.settings?.baseURL !== "string") continue;
		if (sources.has(model.providerID)) continue;
		sources.set(model.providerID, model.settings.baseURL.replace(/\/+$/, ""));
	}
	await refreshRemoteModels(
		db,
		[...sources].map(([providerID, baseURL]) => ({ baseURL, providerID })),
	);
	const catalog = await loadCatalog(ctx, db);
	if (catalog.families.length === 0) return;
	declarations = { catalog };

	await ctx.provider.transform((editor) => {
		const current = declarations;
		if (!current) return;
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
			models: declaredModels(current.catalog),
		} as never);
	});
}

/**
 * Re-reads the catalog and has the host rebuild its models when the set of rows
 * actually changed. An unchanged catalogue is left alone: `provider.reload()`
 * emits `provider.updated`, and reloading on every event would keep the watcher
 * awake forever.
 *
 * Returns whether the host was asked to rebuild.
 */
export async function syncDeclarations({
	ctx,
	db,
}: {
	ctx: Context;
	db: Database;
}): Promise<boolean> {
	invalidateCatalog();
	const catalog = await loadCatalog(ctx, db);
	// What the host needs to rebuild is not only which rows exist. A row's
	// thinking ladder and its declared windows ride along with the model, so a
	// row that keeps its key but gains a level would otherwise stay stale until
	// the next reload for some other reason.
	const before = declarations?.catalog.families.map(declarationSignature);
	const after = catalog.families.map(declarationSignature);
	if (before && sameKeys(before, after)) return false;
	declarations = { catalog };
	try {
		await ctx.provider.reload();
	} finally {
		// The rebuild reads the host's list while it runs, and that list is
		// momentarily partial. A catalogue cached in that window would hold the
		// partial answer for its whole lifetime, so the next reader starts clean.
		invalidateCatalog();
	}
	return true;
}

function declarationSignature(family: ModelFamily) {
	return `${family.key}|${family.variants?.map((variant) => variant.id).join(",") ?? ""}`;
}

function sameKeys(left: readonly string[], right: readonly string[]) {
	return (
		left.length === right.length &&
		left.every((key, index) => key === right[index])
	);
}

/**
 * Re-reads the catalog and has the host rebuild its models, so an edited chain,
 * a limit or a toggled free-only provider reaches the declared windows without
 * restarting the application.
 */
export async function refreshBalancerProvider({
	ctx,
	db,
}: {
	ctx: Context;
	db: Database;
}) {
	invalidateCatalog();
	const catalog = await loadCatalog(ctx, db);
	declarations = { catalog };
	try {
		await ctx.provider.reload();
	} finally {
		invalidateCatalog();
	}
}
