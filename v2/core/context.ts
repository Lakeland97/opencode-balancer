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
/**
 * When the reserve is enforced: always, or only where the limit has run into what
 * the model can hold and there is no room left to give. Absent means always, so an
 * installation that predates the switch keeps the reserve it had.
 */
const bufferEnforceKey = "context_buffer_enforce";
/**
 * The last size measured for the summary instruction the compaction request
 * carries, in tokens. Written by the request hook when a compaction goes past;
 * absent until one has, when the figure measured from the host's source stands.
 */
const compactPromptKey = "compact_prompt_tokens";

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
 * When the reserve is enforced. `always` takes it off any cut; `necessary` takes
 * it only where the limit has run into what the model can hold, which is the one
 * place a cut with nothing left behind it trips the overflow the reserve prevents.
 */
export type BufferEnforcement = "always" | "necessary";

/** Always, unless the user asked for the reserve only where it is needed. */
export function readBufferEnforcement(db: Database): BufferEnforcement {
	return readText(db, bufferEnforceKey) === "necessary"
		? "necessary"
		: "always";
}

export function setBufferEnforcement(
	db: Database,
	value: BufferEnforcement,
): void {
	writeText(db, bufferEnforceKey, value);
}

/**
 * The floor a reserve is held to, in tokens: the last size measured for the
 * summary instruction the compaction request carries, or the figure measured
 * from the host's source when none has been seen yet. A stored value that is not
 * a positive number is treated as absent rather than trusted.
 */
export function readCompactPromptTokens(db: Database): number {
	const stored = Number(readText(db, compactPromptKey));
	return Number.isFinite(stored) && stored > 0 ? stored : COMPACT_PROMPT_TOKENS;
}

/** Records one measured summary-instruction size. The request hook is the caller. */
export function writeCompactPromptTokens(db: Database, tokens: number): void {
	if (!Number.isFinite(tokens) || tokens <= 0) return;
	writeText(db, compactPromptKey, String(Math.round(tokens)));
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
 * The floor under the reserve: the room the summary request's own prompt takes.
 *
 * Compacting sends the conversation **plus** a summarization instruction, and
 * that instruction is the one part the model has not already been sent. So the
 * request needs the cut and the prompt together, and a reserve smaller than the
 * prompt leaves the summary request itself over the window — the same overflow
 * the reserve exists to prevent, arrived at from the other side. It is a floor,
 * not a ceiling: a larger buffer the user set still wins.
 *
 * The figure is learned rather than assumed. The balancer already sees the
 * compaction request go past (`server/prompt-size.ts` measures the instruction
 * the host appended, rounded to the nearest thousand, `server/hooks.ts` stores
 * it), so this is only what is used until the first compaction has been watched.
 * It is what the host's own prompt measured at the time it was written: about
 * 2.5k characters, near 640 tokens, near 680 with the one retry the host sends
 * when a reply skips its template — rounded up, so a real measurement landing
 * near it changes nothing.
 */
const COMPACT_PROMPT_TOKENS = 1_000;

/**
 * The room the compaction itself needs, taken off the cut.
 *
 * Compacting is another request against the same model, and it carries the
 * conversation with it, so cutting at the model's very last token leaves that
 * request nowhere to go — which is how a compaction trips the overflow failure it
 * was meant to prevent. The reserve comes off the limit, so a share of it is a
 * share of the cut the user asked for (`5%` of a 250k limit is 12.5k) and a size
 * is that many tokens; the built-in one is a tenth of the limit or 20k, whichever
 * is larger.
 *
 * A reserve below the measured size of the summary instruction is raised to it,
 * so `1%` of a small window cannot leave the prompt the summary sends with
 * nowhere to sit. The figure is `promptTokens`, the measurement recorded from a
 * real compaction request (`readCompactPromptTokens`), or the source-measured
 * default before one has been seen. It is still capped at a quarter of the
 * ceiling: where a window is so small that keeping the prompt free would leave
 * the conversation no room at all, the cap wins and the cut keeps a quarter. The
 * floor only ever touches a reserve the user made small; the built-in rule is
 * already far above it.
 */
export function compactionReserve(input: {
	/** The cut the limit asks for, before the model's window clamps it. */
	limit: number;
	/** What the cut can actually land on: the model's window, or the limit. */
	ceiling: number;
	buffer?: SizeOrShare;
	/** The measured summary-instruction size, when one has been recorded. */
	promptTokens?: number;
}): number {
	const requested =
		input.buffer === undefined
			? Math.max(Math.round(input.limit / 10), 20_000)
			: measure(input.buffer, input.limit);
	return Math.min(
		Math.max(requested, input.promptTokens ?? COMPACT_PROMPT_TOKENS),
		Math.round(input.ceiling / 4),
	);
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
 * The limit picks the cut. The two limits measure different windows on purpose:
 * the global one is a share of the declared 1M, so "20%" always means 200k
 * whatever is serving, while a per-model one is a share of that model's own
 * window, so 50% of a 200k model is 100k. A per-model limit replaces the global
 * for that model rather than being capped against it. A size, in either place, is
 * simply that many tokens.
 *
 * What the model can actually hold is the outer bound on the cut, and the buffer
 * comes off whatever survives it — so a 250k limit with a 5% buffer cuts at
 * 237.5k, and the same limit on a 200k model cuts at 187.5k. A limit that asks
 * for more than the model holds starts from the model's window instead.
 *
 * A limit below what the model holds leaves room of its own, and whether a
 * reserve still comes off it is the user's call (`bufferEnforcement`); at or past
 * what the model holds the cut sits on the model's own ceiling, where a reserve is
 * not optional. A model whose window is not reported is measured against the
 * declared one, which is what the balancer tells every model.
 */
export function effectiveThreshold(input: {
	globalLimit?: SizeOrShare;
	modelLimit?: SizeOrShare;
	realContext?: number;
	buffer?: SizeOrShare;
	/**
	 * When the reserve is enforced. Defaults to `always`; `necessary` drops it
	 * where the limit already sits below what the model can hold, and the ceiling
	 * keeps its room either way.
	 */
	bufferEnforcement?: BufferEnforcement;
	/** The measured summary-instruction size, when one has been recorded. */
	promptTokens?: number;
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

	const holds = real ?? DECLARED_CONTEXT;
	const ceiling = Math.min(chosen, holds);

	if (chosen < holds && (input.bufferEnforcement ?? "always") === "necessary") {
		return ceiling;
	}

	return (
		ceiling -
		compactionReserve({
			buffer: input.buffer,
			ceiling,
			limit: chosen,
			promptTokens: input.promptTokens,
		})
	);
}

/**
 * Where the cut lands for a limit and buffer as typed, measured against the
 * declared window. The same rule the balancer uses, because a panel readout that
 * computes it differently is a second opinion about the same number.
 */
export function cutFor(
	limitText: string,
	bufferText: string,
	enforcement: string,
): number {
	const limit = parseLimit(limitText);
	if (!limit.ok) return 0;
	const room = parseBuffer(bufferText);
	return effectiveThreshold({
		buffer: room.ok ? room.size : undefined,
		bufferEnforcement: enforcement === "necessary" ? "necessary" : "always",
		globalLimit: limit.size,
	});
}

/**
 * What a buffer as typed works out to in tokens, for the readout that confirms
 * `20` means twenty thousand. A share has no single size, so it reports 0 and
 * the field's own help explains what it measures.
 */
export function bufferTokens(value: string): number {
	const parsed = parseBuffer(value);
	return parsed.ok && parsed.size && "tokens" in parsed.size
		? parsed.size.tokens
		: 0;
}
