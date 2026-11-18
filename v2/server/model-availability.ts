import type { Database } from "bun:sqlite";

/**
 * Which `(provider, model)` pairs a provider has refused, and until when.
 *
 * A provider can answer "this model is not on your plan", "not found", or "does
 * not support this request kind" while the credential itself is perfectly
 * healthy. Treating that as an account failure parked a good key and made the
 * whole provider look broken; treating it as nothing at all sent the next
 * request straight back into the same refusal, because the catalogue still lists
 * the model the provider never intended to serve.
 *
 * The mark belongs to the pair, so one refused model does not hide the rest of
 * that provider's row, and it expires on its own because entitlements and
 * catalogue drift both ways.
 */
type Mark = { at: number; until: number };

/** How long a refusal is believed before the pair is tried again. */
const UNAVAILABLE_MS = 30 * 60_000;

const PREFIX = "model_unavailable:";
// Per store: two databases in one process must not share a verdict about a
// provider, and a test that builds a fresh store has to start from nothing.
const caches = new WeakMap<Database, Map<string, Mark>>();

function cacheFor(db: Database) {
	let cache = caches.get(db);
	if (!cache) {
		cache = new Map();
		caches.set(db, cache);
	}
	return cache;
}

/** The key is JSON so a model id with any punctuation round-trips exactly. */
function pairKey(providerID: string, modelID: string) {
	return JSON.stringify([providerID, modelID]);
}

function storeKey(providerID: string, modelID: string) {
	return `${PREFIX}${pairKey(providerID, modelID)}`;
}

function read(db: Database, key: string): Mark | undefined {
	try {
		const value = db
			.query<{ value: string }, [string]>(
				"SELECT value FROM settings WHERE key = ?",
			)
			.get(key)?.value;
		if (value === undefined) return undefined;
		return JSON.parse(value) as Mark;
	} catch {
		return undefined;
	}
}

function write(db: Database, key: string, mark: Mark) {
	try {
		db.query<unknown, [string, string]>(
			`INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		).run(key, JSON.stringify(mark));
	} catch {}
}

function clear(db: Database, key: string) {
	try {
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(key);
	} catch {}
}

/**
 * Record that this provider will not serve this model for a while. A repeat
 * refusal does not extend the window past the one already held, so two hooks
 * observing one failure cannot push the expiry forward.
 */
export function noteModelUnavailable(
	db: Database,
	providerID: string,
	modelID: string,
	at: number = Date.now(),
) {
	const key = storeKey(providerID, modelID);
	const cache = cacheFor(db);
	const existing = cache.get(pairKey(providerID, modelID)) ?? read(db, key);
	if (existing && existing.until > at) return;
	const mark: Mark = { at, until: at + UNAVAILABLE_MS };
	cache.set(pairKey(providerID, modelID), mark);
	write(db, key, mark);
}

/** Whether this pair is still refused, forgetting the mark once it lapsed. */
export function modelUnavailable(
	db: Database,
	providerID: string,
	modelID: string,
	at: number = Date.now(),
): boolean {
	const pair = pairKey(providerID, modelID);
	const cache = cacheFor(db);
	const mark = cache.get(pair) ?? read(db, storeKey(providerID, modelID));
	if (!mark) return false;
	if (mark.until <= at) {
		cache.delete(pair);
		clear(db, storeKey(providerID, modelID));
		return false;
	}
	cache.set(pair, mark);
	return true;
}

/** Drop the in-process copy; the store remains the record. */
export function resetModelAvailability(db: Database) {
	caches.delete(db);
}
