import type { Database } from "bun:sqlite";

/**
 * Two facts routing learns as it works: which target a row last served, and how
 * large a session's conversation has grown.
 *
 * Both used to live only in module memory, and editing any file reloads the
 * plugin: the panel's `in use` mark vanished on every reload, and a resumed
 * conversation forgot its size, so a failover could hand it to a model with a
 * smaller window and the provider answered with a hard overflow. They are kept
 * in the settings table now, beside every other thing the balancer remembers.
 *
 * A memory cache sits in front of the store. Routing writes a note twice per
 * request (the model hook and the HTTP hook cover the same call), and the store
 * is shared with settings the user is editing, so a write happens only when the
 * value actually changed; reading fills the cache once after a reload.
 *
 * Every function takes the database first and is defensive about it: a store
 * that cannot be read falls back to the cache rather than taking a routed
 * request down with it.
 */
type Served = {
	at: number;
	/** The credential that answered, when the note knows it. */
	alias?: string;
	/** The agent that made the call (`build`, `plan`, a subagent name). */
	agent?: string;
	/**
	 * The rung the connector was actually asked for, after the row's level was
	 * mapped onto that connector's own ladder. This is the honest answer to
	 * "what effort is running": the row's level may not exist on the target.
	 */
	applied?: string;
	modelID: string;
	providerID: string;
	/** The thinking level the request asked for, when it asked for one. */
	variant?: string;
};
type Measured = { at: number; value: number };
/**
 * One row a session has run, with the window the connector that answered holds.
 * Recorded so the compaction watcher still knows where a conversation is after a
 * reload; without it the watcher resolves no rows and quietly stops compacting.
 */
type SessionRow = {
	at?: number;
	context?: number;
	familyKey: string;
	providerID: string;
};

/**
 * How long a "last served" note is meaningful for the panel.
 *
 * The note is a clock, so it has to move: a row that keeps serving must keep
 * saying so. A write per request would turn an in-memory hint into a store write
 * on every hook call, so the stored timestamp is refreshed at most this often.
 */
const SERVED_TTL_MS = 10 * 60_000;
/** How stale the stored clock may get before a repeat note rewrites it. */
const SERVED_REFRESH_MS = 60_000;
/**
 * How long a measured conversation size is trusted.
 *
 * Deliberately unbounded: the figure describes a conversation that has already
 * happened, and it only shrinks when compaction says so. Expiring it would make a
 * resumed session forget it had ever grown, which is precisely when handing it to
 * a smaller model produces the overflow this figure exists to prevent. The note is
 * cleared by compaction and overwritten by the next step that ends.
 */

const SERVED_PREFIX = "served:";
const TOKENS_PREFIX = "session_tokens:";
const ROWS_PREFIX = "session_rows:";

/**
 * The caches are per store, not per process.
 *
 * A process can hold more than one database — a test builds a fresh one per
 * case, and the TUI and the server can each open the file — and a cache shared
 * across them answered one store's question with another's note. That is how an
 * "in use" mark from one in-memory database made a second one report a
 * credential it had never routed to.
 */
type Store = {
	rows: Map<string, SessionRow[]>;
	served: Map<string, Served>;
	tokens: Map<string, Measured>;
};

const stores = new WeakMap<Database, Store>();

/**
 * Every store this process has built.
 *
 * `resetRouteMemory` is the one operation that has no database to name — it
 * exists so a test that reuses a file starts clean — so it has to reach all of
 * them. Real work always names its store.
 */
const everyStore: Store[] = [];

function storeFor(db: Database): Store {
	const existing = stores.get(db);
	if (existing) return existing;
	const store = { rows: new Map(), served: new Map(), tokens: new Map() };
	stores.set(db, store);
	everyStore.push(store);
	return store;
}

function readJSON<T>(db: Database, key: string): T | undefined {
	try {
		const value = db
			.query<{ value: string }, [string]>(
				"SELECT value FROM settings WHERE key = ?",
			)
			.get(key)?.value;
		if (value === undefined) return undefined;
		return JSON.parse(value) as T;
	} catch {
		// An unreadable store is not a reason to lose a route: the cache still
		// holds what this run has learned.
		return undefined;
	}
}

function writeRow(db: Database, key: string, value: string) {
	try {
		db.query<unknown, [string, string]>(
			`INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		).run(key, value);
	} catch {
		// Same reasoning as `readJSON`: the note is a hint, not a request.
	}
}

function deleteRow(db: Database, key: string) {
	try {
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(key);
	} catch {}
}

function sameServed(left: Served | undefined, right: Served) {
	return (
		left !== undefined &&
		left.alias === right.alias &&
		left.agent === right.agent &&
		left.modelID === right.modelID &&
		left.providerID === right.providerID &&
		left.applied === right.applied &&
		left.variant === right.variant
	);
}

export function noteServed(
	db: Database,
	familyKey: string,
	route: {
		agent?: string;
		alias?: string;
		applied?: string;
		modelID: string;
		providerID: string;
		variant?: string;
	},
	at: number = Date.now(),
) {
	const entry: Served = {
		agent: route.agent,
		alias: route.alias,
		applied: route.applied,
		at,
		modelID: route.modelID,
		providerID: route.providerID,
		variant: route.variant,
	};
	const { served } = storeFor(db);
	const before = served.get(familyKey);
	// The hook pair stamps the same target twice a few milliseconds apart, and a
	// chatty row would otherwise write on every request. The stored note is a
	// clock though: skipping the write outright froze it at the first request, so
	// `servedFor` eventually judged a row that was still serving stale and
	// deleted it, and `in use` could not come back for that row in this process.
	// Keeping the stored copy within `SERVED_REFRESH_MS` is enough for it to
	// outlive the TTL while a request costs at most one write a minute.
	if (sameServed(before, entry) && at - (before?.at ?? 0) < SERVED_REFRESH_MS) {
		served.set(familyKey, entry);
		return;
	}
	served.set(familyKey, entry);
	writeRow(db, `${SERVED_PREFIX}${familyKey}`, JSON.stringify(entry));
}

/** The target this row last served with, or undefined when that is stale. */
export function servedFor(
	db: Database,
	familyKey: string,
	at: number = Date.now(),
): Served | undefined {
	const key = `${SERVED_PREFIX}${familyKey}`;
	const { served } = storeFor(db);
	const entry = served.get(familyKey) ?? readJSON<Served>(db, key);
	if (!entry) return undefined;
	if (at - entry.at > SERVED_TTL_MS) {
		served.delete(familyKey);
		deleteRow(db, key);
		return undefined;
	}
	served.set(familyKey, entry);
	return entry;
}

/**
 * Every row currently being served, and by which credential, model and level.
 *
 * One row can be served by one provider while another row is served by a
 * different one — a conversation split across models because a provider was
 * unavailable is exactly the case this reports. Reading the store rather than
 * the cache is what makes a reload show the same picture, and a row whose note
 * has aged out is dropped rather than reported as current.
 */
export function servedEntries(
	db: Database,
	at: number = Date.now(),
): Array<Served & { familyKey: string }> {
	const rows = new Map<string, Served>();
	const { served } = storeFor(db);
	try {
		const stored = db
			.query<{ key: string; value: string }, [string]>(
				"SELECT key, value FROM settings WHERE key LIKE ?",
			)
			.all(`${SERVED_PREFIX}%`);
		for (const row of stored) {
			try {
				const entry = JSON.parse(row.value) as Served;
				if (typeof entry?.at !== "number") continue;
				rows.set(row.key.slice(SERVED_PREFIX.length), entry);
			} catch {}
		}
	} catch {
		// The cache below is still worth reporting.
	}
	// A note written in this run is newer than the stored one until the store is
	// refreshed, so the cache wins when it has something to say.
	for (const [familyKey, entry] of served) rows.set(familyKey, entry);

	const live: Array<Served & { familyKey: string }> = [];
	for (const [familyKey, entry] of rows) {
		if (at - entry.at > SERVED_TTL_MS) {
			served.delete(familyKey);
			deleteRow(db, `${SERVED_PREFIX}${familyKey}`);
			continue;
		}
		live.push({ ...entry, familyKey });
	}
	return live.sort((left, right) => right.at - left.at);
}

/**
 * The conversation size last measured for a session. Routing uses it so a
 * failover never hands a conversation to a model with a smaller window than the
 * conversation already fills.
 */
export function noteSessionTokens(
	db: Database,
	sessionID: string,
	value: number,
	at: number = Date.now(),
) {
	if (!Number.isFinite(value) || value <= 0) return;
	const entry: Measured = { at, value: Math.round(value) };
	const { tokens } = storeFor(db);
	const before = tokens.get(sessionID);
	if (before && before.value === entry.value) {
		tokens.set(sessionID, entry);
		return;
	}
	tokens.set(sessionID, entry);
	writeRow(db, `${TOKENS_PREFIX}${sessionID}`, JSON.stringify(entry));
}

export function sessionTokens(
	db: Database,
	sessionID: string,
	_at: number = Date.now(),
): number | undefined {
	const key = `${TOKENS_PREFIX}${sessionID}`;
	const { tokens } = storeFor(db);
	const entry = tokens.get(sessionID) ?? readJSON<Measured>(db, key);
	if (!entry) return undefined;
	// The figure has no clock: it describes what the conversation holds, and it
	// is cleared by compaction or replaced by the next step that ends.
	tokens.set(sessionID, entry);
	return entry.value;
}

export function forgetSessionTokens(db: Database, sessionID: string) {
	storeFor(db).tokens.delete(sessionID);
	deleteRow(db, `${TOKENS_PREFIX}${sessionID}`);
}

/**
 * Record one row a session has run, with the window that answered it.
 *
 * The compaction watcher asks this for every row a session has touched and
 * measures the conversation against the tightest of them. In memory only, a
 * reload left it with no rows at all — so a session that had already routed
 * stopped being compacted and simply overflowed on the next long turn.
 */
export function noteSessionRow(
	db: Database,
	sessionID: string,
	row: SessionRow,
	at: number = Date.now(),
) {
	const key = `${ROWS_PREFIX}${sessionID}`;
	const { rows } = storeFor(db);
	const existing = rows.get(sessionID) ?? readJSON<SessionRow[]>(db, key);
	const next = (existing ?? []).filter(
		(entry) => entry.familyKey !== row.familyKey,
	);
	const entry: SessionRow = { ...row, at };
	next.push(entry);
	rows.set(sessionID, next);
	writeRow(db, key, JSON.stringify(next));
}

/** The rows this session has run that are still inside the idle window. */
export function sessionRows(
	db: Database,
	sessionID: string,
	at: number = Date.now(),
	ttlMs: number = SERVED_TTL_MS,
): SessionRow[] {
	const key = `${ROWS_PREFIX}${sessionID}`;
	const { rows } = storeFor(db);
	const stored = rows.get(sessionID) ?? readJSON<SessionRow[]>(db, key);
	if (!stored) return [];
	const live = stored.filter((entry) => at - (entry.at ?? 0) <= ttlMs);
	if (live.length === stored.length) {
		rows.set(sessionID, stored);
		return live;
	}
	if (live.length === 0) {
		rows.delete(sessionID);
		deleteRow(db, key);
		return [];
	}
	rows.set(sessionID, live);
	writeRow(db, key, JSON.stringify(live));
	return live;
}

/**
 * Drop the cache this run has built. The store is the record, so this only
 * matters to a test that reuses one database across cases; a fresh database
 * already starts empty.
 */
export function resetRouteMemory() {
	for (const store of everyStore) {
		store.rows.clear();
		store.served.clear();
		store.tokens.clear();
	}
}
