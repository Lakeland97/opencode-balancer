import type { Database } from "bun:sqlite";

/**
 * What every balancer model tells the host its window is. The real connector
 * windows differ wildly, and a host that knows them would compact on its own at
 * a moment the balancer cannot choose; declaring one large window hands that
 * decision to us, and the balancer compacts at its own threshold instead.
 */
export const DECLARED_CONTEXT = 1_000_000;

/** The share of the declared window used when the user has not said otherwise. */
export const DEFAULT_PERCENT = 20;

/**
 * The most a share may be. A hundred percent would put the cut on the model's
 * very last token, which is the one place compaction cannot work from, so the
 * field stops one short of it.
 */
export const MAX_PERCENT = 99;

/**
 * A size in tokens, or a share of whichever window it is measured against. Both
 * the limit and the buffer are written this way, so one field serves a 200k model
 * and a 1M one alike.
 */
export type SizeOrShare = { tokens: number } | { percent: number };

const globalLimitKey = "context_limit";
/** A model's own limit. One per row: who serves it does not change what it holds. */
const modelLimitKey = (familyKey: string) => `model_limit:${familyKey}`;
/** What the global limit was called when it could only be a share. */
const legacyGlobalKey = "context_percent";
/** What a model's limit was called when it could only be a share. */
const legacyModelKey = (familyKey: string) => `model_percent:${familyKey}`;
/** What the model's limit was called when it was stored per provider as well. */
const legacyPerProviderPrefix = "context_percent:";
/** The room to keep free below the window, as the user typed it. */
const bufferKey = "context_buffer";

/** Whether a value is a share the balancer would accept from the user. */
function isValidPercent(percent: number | undefined): percent is number {
	return (
		percent !== undefined &&
		Number.isFinite(percent) &&
		percent > 0 &&
		percent <= MAX_PERCENT
	);
}

/**
 * A stored value as the user typed it, treating an empty one as absent so a
 * cleared field reads as "unset" rather than as an empty string.
 */
function readText(db: Database, key: string): string | undefined {
	const value = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(key)?.value;
	return value === undefined || value.trim() === "" ? undefined : value;
}

/** An empty value clears the row. Callers validate before storing. */
function writeText(db: Database, key: string, value: string): void {
	const trimmed = value.trim();
	if (trimmed === "") {
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(key);
		return;
	}
	db.query<unknown, [string, string]>(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(key, trimmed);
}

/**
 * The grammar both fields share: a size in thousands, or a share.
 *
 * `200` and `200k` are the same two hundred thousand tokens, and a fraction
 * reaches below a thousand (`0.5` is five hundred) without a longer unit; `10%`
 * is a tenth of whatever window the value is measured against. A size may not
 * exceed the declared window and a share stops one short of all of it, since a
 * cut on the model's very last token leaves compacting nowhere to go. Either way
 * the value is kept as typed, so the field reads back what was written rather
 * than a number the user has to reinterpret.
 *
 * The subject only shapes the refusal, so a mistyped value names the field it
 * belongs to.
 */
function parseSizeOrShare(
	value: string,
	subject: string,
):
	| { ok: true; size: SizeOrShare | undefined }
	| { ok: false; message: string } {
	const trimmed = value.trim();
	if (trimmed === "") return { ok: true, size: undefined };

	const share = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
	if (share) {
		const percent = Number(share[1]);
		if (!isValidPercent(percent)) {
			return {
				message: `"${value}" is not a share from 1% to ${MAX_PERCENT}%.`,
				ok: false,
			};
		}
		return { ok: true, size: { percent } };
	}

	const tokens = /^(\d+(?:\.\d+)?)([km])?$/i.exec(trimmed);
	if (tokens) {
		const unit = tokens[2]?.toLowerCase() ?? "k";
		const scale = unit === "m" ? 1_000_000 : 1_000;
		const count = Math.round(Number(tokens[1]) * scale);
		if (count > 0 && count <= DECLARED_CONTEXT) {
			return { ok: true, size: { tokens: count } };
		}
	}

	return {
		message: `"${value}" is not a ${subject}: give a size in thousands, like 20 for 20k, or a share like 10%.`,
		ok: false,
	};
}

/** The compaction buffer as the user typed it: a size or a share. */
export function parseBuffer(value: string) {
	return parseSizeOrShare(value, "buffer");
}

/** The context limit as the user typed it: a size or a share. */
export function parseLimit(value: string) {
	return parseSizeOrShare(value, "context limit");
}

/** A stored value in the form the decision needs; unreadable means unset. */
function readSpec(db: Database, key: string): SizeOrShare | undefined {
	const stored = readText(db, key);
	if (stored === undefined) return undefined;
	const parsed = parseSizeOrShare(stored, "limit");
	return parsed.ok ? parsed.size : undefined;
}

/** The global limit as it was typed, or undefined when the default applies. */
export function readLimit(db: Database): string | undefined {
	return readText(db, globalLimitKey);
}

/** The global limit in the form the decision needs. */
export function readLimitSpec(db: Database): SizeOrShare | undefined {
	return readSpec(db, globalLimitKey);
}

/** An empty value restores the default. Callers validate before storing. */
export function setLimit(db: Database, value: string): void {
	writeText(db, globalLimitKey, value);
}

/** A model's own limit as it was typed, or undefined when it follows the global. */
export function readModelLimit(
	db: Database,
	familyKey: string,
): string | undefined {
	return readText(db, modelLimitKey(familyKey));
}

/** A model's own limit in the form the decision needs. */
export function readModelLimitSpec(
	db: Database,
	familyKey: string,
): SizeOrShare | undefined {
	return readSpec(db, modelLimitKey(familyKey));
}

/** An empty value hands the model back to the global limit. */
export function setModelLimit(
	db: Database,
	familyKey: string,
	value: string,
): void {
	writeText(db, modelLimitKey(familyKey), value);
}

/** The buffer as it was typed, or undefined when the built-in rule applies. */
export function readBuffer(db: Database): string | undefined {
	return readText(db, bufferKey);
}

/** The stored buffer in the form the decision needs. */
export function readBufferSpec(db: Database): SizeOrShare | undefined {
	return readSpec(db, bufferKey);
}

/** An empty value restores the built-in rule. Callers validate before storing. */
export function setBuffer(db: Database, value: string): void {
	writeText(db, bufferKey, value);
}

/**
 * An older value only ever meant a share, and was written as a bare number.
 *
 * A size has always carried a `%` or a unit, so a bare number on an old key is a
 * share that needs its `%` back: without it, `25` would read as twenty-five
 * thousand tokens, which is a different instruction entirely.
 */
function asShare(value: string): string {
	const trimmed = value.trim();
	return /^\d+(?:\.\d+)?$/.test(trimmed) ? `${trimmed}%` : trimmed;
}

/**
 * Move limits an earlier version stored under their old names onto the current
 * ones, and fold a model's per-provider limits onto the model.
 *
 * The limit was once only a share, and a model's share was once stored per model
 * *and* provider, which meant one model could be cut at two sizes depending on
 * which credential happened to answer — a distinction nobody asked for. The limit
 * belongs to the model, so each old value becomes the model's and the old rows go.
 * The model's own current row outranks anything folded from a provider, and a value
 * no setter would have accepted is dropped rather than carried across. Running this
 * on every boot is harmless: after the first pass there is nothing left to move.
 */
export function migrateLimits(db: Database) {
	const drop = (key: string) =>
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(key);
	const migratable = (value: string) =>
		parseSizeOrShare(asShare(value), "limit").ok;

	// The global limit, stored as a bare share under the old name.
	const global = readText(db, legacyGlobalKey);
	if (
		global !== undefined &&
		migratable(global) &&
		readText(db, globalLimitKey) === undefined
	) {
		writeText(db, globalLimitKey, asShare(global));
	}
	drop(legacyGlobalKey);

	// A model's limit under its bare-share name, before the per-provider fold so
	// the model's own row wins.
	for (const row of db
		.query<{ key: string; value: string }, []>(
			`SELECT key, value FROM settings WHERE key LIKE '${legacyModelKey("")}%' ORDER BY key`,
		)
		.all()) {
		const familyKey = row.key.slice(legacyModelKey("").length);
		if (
			familyKey !== "" &&
			migratable(row.value) &&
			readText(db, modelLimitKey(familyKey)) === undefined
		) {
			writeText(db, modelLimitKey(familyKey), asShare(row.value));
		}
		drop(row.key);
	}

	// An even earlier version stored the model's limit per provider as well.
	for (const row of db
		.query<{ key: string; value: string }, []>(
			`SELECT key, value FROM settings WHERE key LIKE '${legacyPerProviderPrefix}%' ORDER BY key`,
		)
		.all()) {
		const rest = row.key.slice(legacyPerProviderPrefix.length);
		const cut = rest.lastIndexOf(":");
		const familyKey = cut > 0 ? rest.slice(0, cut) : rest;
		if (
			familyKey !== "" &&
			migratable(row.value) &&
			readText(db, modelLimitKey(familyKey)) === undefined
		) {
			writeText(db, modelLimitKey(familyKey), asShare(row.value));
		}
		drop(row.key);
	}
}

/**
 * The room the compaction itself needs.
 *
 * Compacting is another request against the same model, and it carries the
 * conversation with it, so triggering at the model's very last token leaves that
 * request nowhere to go — which is how a compaction trips the overflow failure it
 * was meant to prevent. By default the reserve is a tenth of the window or 20k,
 * whichever is larger: the two agree at 200k, and the fixed floor is what a small
 * window needs. A model with a hard cap below what it reports wants to stop
 * earlier than that, so the user can name their own buffer in tokens or as a share
 * of the window. Either way it is capped at a quarter of the window, so a model
 * that reports very little is still left something to hold a conversation in.
 */
export function compactionReserve(
	realContext: number,
	buffer?: SizeOrShare,
): number {
	const requested =
		buffer === undefined
			? Math.max(Math.round(realContext / 10), 20_000)
			: measure(buffer, realContext);
	return Math.min(requested, Math.round(realContext / 4));
}

/** A size or a share, read as a count of tokens against one window. */
function measure(size: SizeOrShare, base: number): number {
	return "tokens" in size
		? size.tokens
		: Math.round((base * size.percent) / 100);
}

/**
 * A token count the way it is said aloud: 200000 reads as 200k, 1000000 as 1m.
 * Kept here so a message and the panel that shows the same number agree.
 */
export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "";
	// A value can be small enough that rounding to thousands would misreport it.
	if (value < 1_000) return String(Math.round(value));
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`;
	}
	return `${Math.round(value / 1000)}k`;
}

/**
 * The token count the balancer compacts a conversation at.
 *
 * The two limits measure different windows on purpose: the global one is a slice
 * of the declared 1M, so "20%" always means 200k whatever is serving, while a
 * per-model one is a slice of that model's own window, so 50% of a 200k model is
 * 100k. A per-model limit replaces the global for that model rather than being
 * capped against it. A size, in either place, is simply that many tokens.
 *
 * The model's real window is the hard ceiling underneath either one: a limit that
 * lands past what the model can actually hold is clamped to sit a reserve below it,
 * which is what makes "30%" mean 300k on a 1M model and 180k on a 200k one. A model
 * whose window is unknown has no ceiling to clamp against, so the limit stands alone
 * rather than the conversation being cut at nothing.
 */
export function effectiveThreshold(input: {
	globalLimit?: SizeOrShare;
	modelLimit?: SizeOrShare;
	realContext?: number;
	buffer?: SizeOrShare;
}): number {
	const real =
		typeof input.realContext === "number" && input.realContext > 0
			? input.realContext
			: undefined;

	// A per-model limit has nothing but that model to measure against, so an
	// unknown window falls back to the declared one rather than to zero.
	const chosen =
		input.modelLimit !== undefined
			? measure(input.modelLimit, real ?? DECLARED_CONTEXT)
			: measure(
					input.globalLimit ?? { percent: DEFAULT_PERCENT },
					DECLARED_CONTEXT,
				);

	if (real === undefined) return chosen;
	// The ceiling is the window less what compacting the conversation will need.
	return Math.min(chosen, real - compactionReserve(real, input.buffer));
}
