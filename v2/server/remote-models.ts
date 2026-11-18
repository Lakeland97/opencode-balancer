import type { Database } from "bun:sqlite";
import { listAccounts } from "../core/accounts";
import { now } from "../core/time";
import { recordLog } from "./log";

/**
 * What a provider says it can serve, asked of the provider itself.
 *
 * The host's model list is assembled from configuration — whatever was written
 * into `opencode.json` when the provider was connected — so a provider that adds
 * a model, changes a window, or renames its catalogue is invisible until
 * somebody edits that file by hand. Every OpenAI-compatible endpoint this
 * balancer speaks publishes `GET {base}/models`, so reading it is the only
 * honest source: no list to maintain and nothing to guess.
 *
 * Discovery never blocks routing. A read that has no answer yet returns what was
 * cached (or nothing) and starts the fetch in the background; when it lands, the
 * caller is told it changed so the host can rebuild. A provider that does not
 * answer, answers with something other than a catalogue, or refuses the key is
 * left out of this pass; the declared models still stand and the next refresh
 * tries again.
 */

export type RemoteModel = {
	/** The provider's own id for the model. */
	id: string;
	/** The provider's display name when it sent one. */
	name?: string;
	/** The window the provider reports, when it reports one. */
	context?: number;
	/** The answer cap the provider reports, when it reports one. */
	output?: number;
	/** The provider's own creation instant, for ordering a catalogue by age. */
	created?: number;
};

type Cached = { at: number; models: readonly RemoteModel[]; failed?: string };

/** Long enough that a chatty session is not one request per call, short enough to notice a new model. */
const TTL_MS = 10 * 60_000;
/** A provider that hangs must not hold a catalogue read open. */
const TIMEOUT_MS = 8_000;
/** A failed read is retried sooner than a good one, without becoming a request per poll. */
const FAILURE_MS = 60_000;

const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<void>>();

export function invalidateRemoteModels() {
	cache.clear();
}

function numeric(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.round(value)
		: undefined;
}

/**
 * The window a catalogue entry describes, in whichever spelling that provider
 * used. The OpenAI shape has no window at all, so a provider that reports one
 * does it in one of a handful of fields; none of them is required.
 */
function windowOf(entry: Record<string, unknown>) {
	const limit = entry.limit as Record<string, unknown> | undefined;
	const metadata = entry.metadata as Record<string, unknown> | undefined;
	const top =
		entry.context_window ??
		entry.context_length ??
		entry.max_context_tokens ??
		metadata?.context_limit ??
		metadata?.context_length;
	return numeric(limit?.context) ?? numeric(top);
}

function outputOf(entry: Record<string, unknown>) {
	const limit = entry.limit as Record<string, unknown> | undefined;
	const metadata = entry.metadata as Record<string, unknown> | undefined;
	const top =
		entry.max_output_tokens ??
		entry.max_completion_tokens ??
		metadata?.output_budget ??
		metadata?.max_output_tokens;
	return numeric(limit?.output) ?? numeric(top);
}

/**
 * One catalogue answer, in either shape worth accepting: `{data: [...]}` (OpenAI
 * and Anthropic) or a bare array. Anything else is not a catalogue.
 */
export function parseCatalogue(body: unknown): RemoteModel[] | undefined {
	const list = Array.isArray(body)
		? body
		: body &&
				typeof body === "object" &&
				Array.isArray((body as { data?: unknown }).data)
			? (body as { data: unknown[] }).data
			: undefined;
	if (!list) return undefined;

	const models: RemoteModel[] = [];
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const id = entry.id ?? entry.modelID;
		if (typeof id !== "string" || id.trim() === "") continue;
		models.push({
			context: windowOf(entry),
			created: numeric(entry.created),
			id,
			name: typeof entry.name === "string" ? entry.name : undefined,
			output: outputOf(entry),
		});
	}
	return models;
}

/** The credential that may read this provider's catalogue. */
function authFor(db: Database, providerID: string) {
	const account = listAccounts(db, providerID).find((entry) => !entry.disabled);
	if (!account) return undefined;
	const auth = account.auth;
	const key =
		auth.type === "api"
			? auth.key
			: auth.type === "wellknown"
				? auth.token
				: auth.access;
	return { auth, key };
}

async function fetchCatalogue(
	db: Database,
	providerID: string,
	baseURL: string,
): Promise<Cached> {
	const credential = authFor(db, providerID);
	if (!credential) return { at: now(), failed: "no credential", models: [] };

	const url = `${baseURL.replace(/\/+$/, "")}/models`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${credential.key}`,
				"x-api-key": credential.key,
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		return {
			at: now(),
			failed: error instanceof Error ? error.message : String(error),
			models: [],
		};
	}
	if (!response.ok) {
		return { at: now(), failed: `HTTP ${response.status}`, models: [] };
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { at: now(), failed: "unreadable body", models: [] };
	}
	const models = parseCatalogue(body);
	return models
		? { at: now(), models }
		: { at: now(), failed: "not a model list", models: [] };
}

function cacheKey(providerID: string, baseURL: string) {
	return `${providerID}\u0000${baseURL}`;
}

/**
 * The catalogue this provider publishes, from cache. A miss starts the read and
 * returns empty for now: a catalogue request must never be able to hold a routed
 * call or a panel render open.
 */
export function cachedRemoteModels(
	db: Database,
	providerID: string,
	baseURL: string,
): readonly RemoteModel[] {
	const key = cacheKey(providerID, baseURL);
	const cached = cache.get(key);
	const ttl = cached?.failed ? FAILURE_MS : TTL_MS;
	if (cached && now() - cached.at < ttl) return cached.models;

	if (!inFlight.has(key)) {
		inFlight.set(
			key,
			fetchCatalogue(db, providerID, baseURL)
				.then((next) => {
					cache.set(key, next);
					if (next.failed) {
						// A provider that has stopped publishing a catalogue is worth a
						// line; the declared models still serve it.
						recordLog(
							"route",
							`${providerID} did not publish a model list (${next.failed}); using the declared models`,
						);
					}
				})
				.catch(() => {})
				.finally(() => {
					inFlight.delete(key);
				}),
		);
	}
	return cached?.models ?? [];
}

/**
 * Read every connector's catalogue now and report whether the answer changed.
 *
 * Used when the plugin wants the picker to be complete before it is opened, and
 * by the provider watcher so a model added on the provider's side shows up
 * without editing `opencode.json`.
 */
export async function refreshRemoteModels(
	db: Database,
	sources: ReadonlyArray<{ baseURL: string; providerID: string }>,
): Promise<boolean> {
	const results = await Promise.all(
		sources.map(async (source) => {
			const key = cacheKey(source.providerID, source.baseURL);
			const before = cache
				.get(key)
				?.models.map((model) => model.id)
				.join("\n");
			const next = await fetchCatalogue(db, source.providerID, source.baseURL);
			cache.set(key, next);
			const after = next.models.map((model) => model.id).join("\n");
			return before !== after;
		}),
	);
	return results.some(Boolean);
}
