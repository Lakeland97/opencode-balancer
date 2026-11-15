import type { Database } from "bun:sqlite";

/**
 * How long a session's balance may sit idle before it starts over.
 *
 * A provider's quota refills on a five-hour window, so a trail older than one
 * describes a world that no longer exists: the credentials this session had
 * already tried are worth trying first again, and the head of the order is where
 * a fresh balance starts. The clock is refreshed by every routed request, so this
 * measures idleness rather than elapsed time — a session that keeps talking never
 * reaches it, however long it runs.
 */
export const DEFAULT_REBALANCE_MS = 5 * 60 * 60_000;

const rebalanceKey = "rebalance_after";

const UNITS: Record<string, number> = {
	d: 24 * 60 * 60_000,
	h: 60 * 60_000,
	m: 60_000,
	s: 1_000,
};

export type ParsedDuration =
	| { error: string; ok: false }
	| { ms?: number; ok: true };

/**
 * Read a duration as the user typed it: `90m`, `5h`, `1d 2h`, or `0` for never.
 *
 * A unit is required, because the fields either side of this one read a bare
 * number as thousands of tokens — `5` here could not be told apart from five
 * hours or five seconds. An empty value is the built-in default, not zero, so a
 * field left blank keeps the window rather than switching it off.
 */
export function parseDuration(text: string): ParsedDuration {
	const trimmed = text.trim().toLowerCase();
	if (trimmed === "") return { ok: true };
	if (trimmed === "0" || trimmed === "never" || trimmed === "off") {
		return { ms: 0, ok: true };
	}

	let total = 0;
	for (const part of trimmed.split(/[\s,]+/).filter(Boolean)) {
		const piece = /^(\d+(?:\.\d+)?)([dhms])$/.exec(part);
		if (!piece) {
			return {
				error: `"${text}" is not a duration. Give a number and a unit, like 90m or 5h; 0 switches the window off.`,
				ok: false,
			};
		}
		total += Number(piece[1]) * (UNITS[piece[2] as string] ?? 0);
	}
	return { ms: Math.round(total), ok: true };
}

/** A duration for a field to show, in the largest unit that stays whole. */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "never";
	if (ms % 60_000 !== 0) return `${Math.round(ms / 1_000)}s`;
	if (ms % 3_600_000 !== 0) return `${Math.round(ms / 60_000)}m`;
	if (ms % 86_400_000 !== 0) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

/** The window as typed, or undefined when it has never been set. */
export function readRebalance(db: Database): string | undefined {
	return db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(rebalanceKey)?.value;
}

export function setRebalance(db: Database, value: string): void {
	db.query<unknown, [string, string]>(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(rebalanceKey, value);
}

/**
 * The idle window in milliseconds. `0` means a trail never goes stale on its own.
 * Anything unreadable falls back to the default rather than to an accidental
 * "never": a typo must not pin a session to one trail for good.
 */
export function rebalanceAfterMs(db: Database): number {
	const text = readRebalance(db);
	if (text === undefined) return DEFAULT_REBALANCE_MS;
	const parsed = parseDuration(text);
	return parsed.ok && parsed.ms !== undefined
		? parsed.ms
		: DEFAULT_REBALANCE_MS;
}
