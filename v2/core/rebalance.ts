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
const autoKey = "rebalance_auto";

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

/**
 * The window as hours and minutes, for the note beside the field.
 *
 * `formatDuration` is for editing: it wants one unit, so `90m` stays `90m`
 * rather than becoming `1.5h`. This is for reading, and reads the way a person
 * says it — `1h 30m`, `5h`, `45m` — so the field's value and the window it is
 * actually applied as can be compared at a glance.
 */
export function formatSpan(ms: number): string {
	if (ms <= 0) return "never";
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.round((ms % 3_600_000) / 60_000);
	const whole = minutes === 60 ? hours + 1 : hours;
	const rest = minutes === 60 ? 0 : minutes;
	if (whole === 0) return `${rest}m`;
	return rest === 0 ? `${whole}h` : `${whole}h ${rest}m`;
}

/**
 * How long until the balance lapses, read the way the note says it: `(in 4h
 * 12m)`. A remainder under a minute is said as `<1m` rather than `0m`, because
 * the note means "about to happen", not "already happened".
 */
export function formatRemaining(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	if (ms < 60_000) return "<1m";
	return formatSpan(ms);
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
 * Whether idleness drops a trail at all. Unset reads as on, which is what every
 * version before the switch did.
 */
export function getRebalanceAuto(db: Database): boolean {
	const row = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(autoKey);
	return row?.value !== "0";
}

export function setRebalanceAuto(db: Database, enabled: boolean): void {
	db.query<unknown, [string, string]>(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(autoKey, enabled ? "1" : "0");
}

/**
 * The idle window in milliseconds. `0` means a trail never goes stale on its own,
 * which is also what the switch being off says: the length is kept beside it, so
 * turning the switch back on restores the window that was set rather than a
 * default nobody chose. Anything unreadable falls back to the default rather than
 * to an accidental "never": a typo must not pin a session to one trail for good.
 */
export function rebalanceAfterMs(db: Database): number {
	return rebalanceWindowMs(getRebalanceAuto(db), readRebalance(db));
}

/**
 * The window those two settings add up to, without a database in hand.
 *
 * The panel shows the number beside the field, so it needs the same answer the
 * router will use — including the switch being off and a value it could not
 * parse — rather than re-deriving it and drifting from the server.
 */
export function rebalanceWindowMs(auto: boolean, text: string | undefined) {
	if (!auto) return 0;
	if (text === undefined) return DEFAULT_REBALANCE_MS;
	const parsed = parseDuration(text);
	return parsed.ok && parsed.ms !== undefined
		? parsed.ms
		: DEFAULT_REBALANCE_MS;
}
