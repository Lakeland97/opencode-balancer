/**
 * When a provider says its quota comes back.
 *
 * A park is ours and lasts as long as we decided; what the endpoint said about
 * its own refill is evidence about the world, and the panel is the only place
 * with room to show it. The words arrive inside whatever error the provider
 * felt like writing, so this reads them out and hands back a time — never a
 * promise: the marker is still cleared by the next attempt, now as before.
 *
 * Only shapes that have actually been seen in the log are matched, plus the
 * clock time the refusal in `request-state.ts` describes:
 *
 *   `resets in 12d 23h`                    (relative)
 *   `resets at 2026-11-14T14:21:16.768Z`   (absolute)
 *   `They reset at 11:27 AM.`              (local clock time)
 */

const UNIT_MS: Record<string, number> = {
	d: 86_400_000,
	h: 3_600_000,
	m: 60_000,
	s: 1_000,
};

/**
 * Provider prose spells units however it likes, so both `23h` and `23 hours`
 * read the same here. This is deliberately more forgiving than the duration
 * grammar the settings fields use, which must refuse what it cannot be sure of;
 * this only ever produces a line of text, and a wrong one is caught by the
 * sanity bounds below rather than by a stricter pattern.
 */
const UNIT_WORDS: Record<string, string> = {
	day: "d",
	days: "d",
	hour: "h",
	hours: "h",
	hr: "h",
	hrs: "h",
	min: "m",
	mins: "m",
	minute: "m",
	minutes: "m",
	sec: "s",
	second: "s",
	seconds: "s",
	secs: "s",
};

/** The wording that introduces a refill, however the provider phrases it. */
const RESET_WORDS =
	/(?:reset|refill|replenish|retry|try again|available|back)/i;

/** `resets in 12d 23h`, `try again after 30 seconds`. */
const RELATIVE_RESET =
	/(?:resets?|refills?|replenish(?:es)?|retries|retry|try again|available|back)\b[^0-9\n]{0,24}?(?:in|after)\s+/i;

/** A token of a duration, compact or spelled out. */
const DURATION_TOKEN =
	/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec|d|h|m|s)\b/gi;

/** An ISO 8601 instant, with or without a zone. */
const ISO_INSTANT =
	/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?/;

/** `14:21`, `14:21:16`, or `4:21 PM`. */
const CLOCK_TIME =
	/(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?|(\d{1,2})\s*([ap]\.?m\.?)/i;

/** A month, so a date that is not today still reads as a date rather than a clock. */
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/**
 * A year, in milliseconds. A quota window is a day, a week, or a month; anything
 * a year out is not a refill this credential is waiting for, so it is refused
 * rather than shown as a date the reader would have to doubt.
 */
const MAX_AHEAD_MS = 366 * 86_400_000;

function unitMs(unit: string): number {
	const compact = UNIT_MS[unit.toLowerCase()];
	if (compact !== undefined) return compact;
	return UNIT_MS[UNIT_WORDS[unit.toLowerCase()] as string] ?? 0;
}

/**
 * Whether reset wording sits close enough before an offset to belong to it: a
 * timestamp quoted in a log line is not this credential's refill.
 */
function resetWordsBefore(text: string, index: number): boolean {
	return RESET_WORDS.test(text.slice(Math.max(0, index - 60), index));
}

/** The duration that starts within a short step of `from`, if one does. */
function durationAfter(text: string, from: number): number | undefined {
	let total = 0;
	let end = from;
	let matched = false;
	DURATION_TOKEN.lastIndex = from;
	while (true) {
		const match = DURATION_TOKEN.exec(text);
		if (!match) break;
		// Tokens have to run on from each other (`12d 23h`), not be gathered up
		// from anywhere later in the sentence.
		if (match.index - end > 3) break;
		const unit = match[2] as string;
		total += Number(match[1]) * unitMs(unit);
		end = match.index + match[0].length;
		matched = true;
	}
	return matched ? Math.round(total) : undefined;
}

/** An absolute instant written out, if one belongs to a refill. */
function parseAbsolute(text: string): number | undefined {
	const iso = ISO_INSTANT.exec(text);
	if (!iso || !resetWordsBefore(text, iso.index ?? 0)) return undefined;
	const parsed = Date.parse(iso[0]);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** A local clock time, on the next day it falls. */
function parseClock(text: string, at: number): number | undefined {
	const clock = CLOCK_TIME.exec(text);
	if (!clock || !resetWordsBefore(text, clock.index ?? 0)) return undefined;
	const hour12 = clock[3] ?? clock[5];
	let hour = Number(clock[1] ?? clock[4]);
	const minute = Number(clock[2] ?? 0);
	if (hour12 !== undefined) {
		// A 12-hour clock with no marker is ambiguous, so only a written one
		// adjusts the hour; `12 AM` is midnight, not noon.
		const afternoon = /p/i.test(hour12);
		const twelve = hour === 12;
		hour = afternoon ? (twelve ? 12 : hour + 12) : twelve ? 0 : hour;
	}
	if (hour > 23 || minute > 59) return undefined;

	const when = new Date(at);
	when.setHours(hour, minute, 0, 0);
	// A clock time with no date is the next time that clock comes round, which is
	// what a provider means when it names a time that has already passed today.
	if (when.getTime() <= at) when.setDate(when.getDate() + 1);
	return when.getTime();
}

/**
 * The instant a provider said it would serve this credential again, or nothing
 * when it did not say, said it unclearly, or named a time that cannot be what it
 * meant. `at` is the reference time: the moment the failure arrived.
 *
 * Most precise first. A written instant beats a relative amount, which beats a
 * bare clock time — a clock is the one shape that could belong to some other
 * clause of the sentence, so it is only believed when nothing better was said.
 */
export function parseRollover(text: string, at: number): number | undefined {
	if (!text.trim()) return undefined;

	const absolute = parseAbsolute(text);
	if (absolute !== undefined) return bounded(absolute, at);

	const relative = RELATIVE_RESET.exec(text);
	if (relative) {
		const ms = durationAfter(text, relative.index + relative[0].length);
		if (ms !== undefined && ms > 0) return bounded(at + ms, at);
	}

	const clock = parseClock(text, at);
	return clock === undefined ? undefined : bounded(clock, at);
}

/** Nothing a year out is a refill this credential is waiting for. */
function bounded(candidate: number, at: number): number | undefined {
	return candidate > at && candidate - at <= MAX_AHEAD_MS
		? candidate
		: undefined;
}

/**
 * A time for a line of text: a clock while it is today, a date once it is not,
 * and a year only when the year is not this one. The panel shows this beside
 * `limited` where the row has room for nothing longer.
 */
export function formatRollover(at: number, reference: number): string {
	const when = new Date(at);
	const today = new Date(reference);
	const hours = String(when.getHours()).padStart(2, "0");
	const minutes = String(when.getMinutes()).padStart(2, "0");
	const clock = `${hours}:${minutes}`;

	const sameDay =
		when.getFullYear() === today.getFullYear() &&
		when.getMonth() === today.getMonth() &&
		when.getDate() === today.getDate();
	if (sameDay) return clock;

	const date = `${MONTHS[when.getMonth()]} ${when.getDate()}`;
	if (when.getFullYear() === today.getFullYear()) return `${date} ${clock}`;
	return `${date} ${when.getFullYear()} ${clock}`;
}
