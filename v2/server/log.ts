import { now } from "../core/time";

export type LogKind = "route" | "failover" | "config" | "compact" | "error";

export type LogEntry = { at: number; kind: LogKind; text: string };

/** Enough to answer "what just happened" without growing without bound. */
const limit = 200;

const entries: LogEntry[] = [];

/**
 * Record one decision the balancer made. The log lives in memory for the run
 * of the plugin, so it says what this process actually did, not what the
 * database suggests it should have done.
 */
export function recordLog(kind: LogKind, text: string, at: number = now()) {
	entries.push({ at, kind, text });
	if (entries.length > limit) entries.splice(0, entries.length - limit);
}

/** Oldest first, so the panel can read top to bottom like a terminal. */
export function readLog(): LogEntry[] {
	return entries.slice();
}

export function clearLog() {
	entries.length = 0;
}
