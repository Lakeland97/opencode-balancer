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

const globalKey = "context_percent";
/** A model's own share. One per row: who serves it does not change what it holds. */
const modelKey = (familyKey: string) => `model_percent:${familyKey}`;
/** What the model's share was called when it was stored per provider as well. */
const legacyModelPrefix = "context_percent:";
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
 * Reads a share, treating anything a setter would have cleared as absent. A
 * malformed row must read as "unset" and fall back to the default, not as a NaN
 * that would leave nothing able to hold a conversation.
 */
function readPercent(db: Database, key: string): number | undefined {
	const value = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(key)?.value;
	if (value === undefined) return undefined;
	const percent = Number(value);
	return Number.isFinite(percent) && percent > 0 && percent <= MAX_PERCENT
		? percent
		: undefined;
}

function writePercent(
	db: Database,
	key: string,
	percent: number | undefined,
): void {
	if (!isValidPercent(percent)) {
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(key);
		return;
	}
	db.query<unknown, [string, string]>(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(key, String(percent));
}

/** The share of the declared window to fill before compacting. */
export function readGlobalPercent(db: Database): number {
	return readPercent(db, globalKey) ?? DEFAULT_PERCENT;
}

/** Setting the share to undefined, or outside 1–99, restores the default. */
export function setGlobalPercent(
	db: Database,
	percent: number | undefined,
): void {
	writePercent(db, globalKey, percent);
}

/** The share of one model's own window, or undefined when it follows the global. */
export function readModelPercent(
	db: Database,
	familyKey: string,
): number | undefined {
	return readPercent(db, modelKey(familyKey));
}

/** Setting the share to undefined, or outside 1–99, removes the override. */
export function setModelPercent(
	db: Database,
	familyKey: string,
	percent: number | undefined,
): void {
	writePercent(db, modelKey(familyKey), percent);
}

/**
 * Fold the per-provider shares of an earlier version onto the model.
 *
 * A row's share was once stored per model *and* provider, which meant one model
 * could be compacted at two sizes depending on which credential happened to
 * answer — not a distinction anyone asked for, and one the panel had to repeat a
 * whole field to express. The share belongs to the model, so each old value
 * becomes the model's (the first in key order where a model somehow held two) and
 * the old rows go. Running this on every boot is harmless: after the first pass
 * there is nothing left to fold.
 */
export function migrateModelPercent(db: Database) {
	const rows = db
		.query<{ key: string; value: string }, []>(
			`SELECT key, value FROM settings WHERE key LIKE '${legacyModelPrefix}%' ORDER BY key`,
		)
		.all();
	for (const row of rows) {
		const rest = row.key.slice(legacyModelPrefix.length);
		const cut = rest.lastIndexOf(":");
		const familyKey = cut > 0 ? rest.slice(0, cut) : rest;
		const percent = Number(row.value);
		if (
			familyKey !== "" &&
			isValidPercent(percent) &&
			readPercent(db, modelKey(familyKey)) === undefined
		) {
			writePercent(db, modelKey(familyKey), percent);
		}
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(
			row.key,
		);
	}
}

/** What the user asked to keep free below a model's window, before compacting. */
export type CompactionBuffer = { tokens: number } | { percent: number };

/**
 * The buffer as the user typed it: a size in thousands, or a share of the
 * model's own window. `20` and `20k` are the same twenty thousand tokens, and a
 * fraction reaches below a thousand (`0.5` is five hundred) without a longer
 * unit; `10%` is a tenth of whatever model is serving. Both are kept as typed, so
 * the field reads back what was written rather than a number the user has to
 * reinterpret.
 */
export function parseBuffer(
	value: string,
):
	| { ok: true; buffer: CompactionBuffer | undefined }
	| { ok: false; message: string } {
	const trimmed = value.trim();
	if (trimmed === "") return { buffer: undefined, ok: true };

	const share = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
	if (share) {
		const percent = Number(share[1]);
		if (!isValidPercent(percent)) {
			return {
				message: `"${value}" is not a share from 1% to ${MAX_PERCENT}%.`,
				ok: false,
			};
		}
		return { buffer: { percent }, ok: true };
	}

	// A bare number is thousands, which is the size a buffer is ever set to;
	// `k` says the same out loud and `m` exists so a large one can be written
	// without a long string of zeros.
	const tokens = /^(\d+(?:\.\d+)?)([km])?$/i.exec(trimmed);
	if (tokens) {
		const unit = tokens[2]?.toLowerCase() ?? "k";
		const scale = unit === "m" ? 1_000_000 : 1_000;
		const count = Math.round(Number(tokens[1]) * scale);
		if (count > 0 && count <= DECLARED_CONTEXT) {
			return { buffer: { tokens: count }, ok: true };
		}
	}

	return {
		message: `"${value}" is not a buffer: give a size in thousands like 20, or a share like 10%.`,
		ok: false,
	};
}

/** The buffer as it was typed, or undefined when the built-in rule applies. */
export function readBuffer(db: Database): string | undefined {
	const value = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(bufferKey)?.value;
	return value === undefined || value.trim() === "" ? undefined : value;
}

/** The stored buffer in the form the decision needs; unreadable means the default. */
export function readBufferSpec(db: Database): CompactionBuffer | undefined {
	const stored = readBuffer(db);
	if (stored === undefined) return undefined;
	const parsed = parseBuffer(stored);
	return parsed.ok ? parsed.buffer : undefined;
}

/** An empty value restores the built-in rule. Callers validate before storing. */
export function setBuffer(db: Database, value: string): void {
	const trimmed = value.trim();
	if (trimmed === "") {
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(
			bufferKey,
		);
		return;
	}
	db.query<unknown, [string, string]>(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(bufferKey, trimmed);
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
	buffer?: CompactionBuffer,
): number {
	const requested =
		buffer === undefined
			? Math.max(Math.round(realContext / 10), 20_000)
			: "tokens" in buffer
				? buffer.tokens
				: Math.round((realContext * buffer.percent) / 100);
	return Math.min(requested, Math.round(realContext / 4));
}

/**
 * The token count the balancer compacts a conversation at.
 *
 * The two shares measure different windows on purpose: the global one is a
 * slice of the declared 1M, so "20%" always means 200k whatever is serving,
 * while a per-model share is a slice of that model's own window, so 50% of a
 * 200k model is 100k. A per-model share replaces the global for that model
 * rather than being capped against it.
 *
 * The model's real window is the hard ceiling underneath either one: a share of
 * the declared window that lands past what the model can actually hold is
 * clamped to sit a reserve below it, which is what makes "30%" mean 300k on a 1M
 * model and 180k on a 200k one. A model whose window is unknown has no ceiling to
 * clamp against, so the share stands alone rather than the conversation being cut
 * at nothing.
 */
export function effectiveThreshold(input: {
	globalPercent: number;
	modelPercent?: number;
	realContext?: number;
	buffer?: CompactionBuffer;
}): number {
	const real =
		typeof input.realContext === "number" && input.realContext > 0
			? input.realContext
			: undefined;

	// A per-model share has nothing but that model to measure against, so an
	// unknown window falls back to the declared one rather than to zero.
	const override = input.modelPercent;
	const base =
		override === undefined ? DECLARED_CONTEXT : (real ?? DECLARED_CONTEXT);
	const percent = override === undefined ? input.globalPercent : override;

	const chosen = Math.round((base * percent) / 100);
	if (real === undefined) return chosen;
	// The ceiling is the window less what compacting the conversation will need.
	return Math.min(chosen, real - compactionReserve(real, input.buffer));
}
