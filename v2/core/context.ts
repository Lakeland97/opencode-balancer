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

const globalKey = "context_percent";
const targetKey = (familyKey: string, providerID: string) =>
	`context_percent:${familyKey}:${providerID}`;

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
	return Number.isFinite(percent) && percent > 0 && percent <= 100
		? percent
		: undefined;
}

function writePercent(
	db: Database,
	key: string,
	percent: number | undefined,
): void {
	if (
		percent === undefined ||
		!Number.isFinite(percent) ||
		percent <= 0 ||
		percent > 100
	) {
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

/** Setting the share to undefined, or outside 1–100, restores the default. */
export function setGlobalPercent(
	db: Database,
	percent: number | undefined,
): void {
	writePercent(db, globalKey, percent);
}

/** The share of one model's own window, or undefined when it follows the global. */
export function readTargetPercent(
	db: Database,
	familyKey: string,
	providerID: string,
): number | undefined {
	return readPercent(db, targetKey(familyKey, providerID));
}

/** Setting the share to undefined, or outside 1–100, removes the override. */
export function setTargetPercent(
	db: Database,
	familyKey: string,
	providerID: string,
	percent: number | undefined,
): void {
	writePercent(db, targetKey(familyKey, providerID), percent);
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
 * clamped to it, which is what makes "30%" mean 300k on a 1M model and 200k on
 * a 200k one. A model whose window is unknown has no ceiling to clamp against,
 * so the share stands alone rather than the conversation being cut at nothing.
 */
export function effectiveThreshold(input: {
	globalPercent: number;
	targetPercent?: number;
	realContext?: number;
}): number {
	const real =
		typeof input.realContext === "number" && input.realContext > 0
			? input.realContext
			: undefined;

	// A per-model share has nothing but that model to measure against, so an
	// unknown window falls back to the declared one rather than to zero.
	const override = input.targetPercent;
	const base =
		override === undefined ? DECLARED_CONTEXT : (real ?? DECLARED_CONTEXT);
	const percent = override === undefined ? input.globalPercent : override;

	const chosen = Math.round((base * percent) / 100);
	return real === undefined ? chosen : Math.min(chosen, real);
}
