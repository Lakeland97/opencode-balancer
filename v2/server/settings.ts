import type { Database } from "bun:sqlite";
import {
	DEFAULT_PERCENT,
	formatTokens,
	parseBuffer,
	parseLimit,
	readBuffer,
	type SizeOrShare,
	setBuffer,
	setBufferEnforcement,
	setLimit,
	setModelLimit,
} from "../core/context";
import { setBalancingEnabled } from "../core/priority";
import {
	formatDuration,
	parseDuration,
	readRebalance,
	rebalanceAfterMs,
	setRebalance,
	setRebalanceAuto,
} from "../core/rebalance";
import { forgetRoutingMemory } from "./hooks";
import { recordLog } from "./log";

/** The answer every setting write gives: a sentence for the user, or a refusal. */
export type WriteResult = { ok: boolean; message: string };

/**
 * How a limit reads in a sentence: a size in tokens, or a share of the window it
 * is measured against.
 */
function describeLimit(size: SizeOrShare, window: string): string {
	return "tokens" in size
		? formatTokens(size.tokens)
		: `${size.percent}% of ${window}`;
}

/**
 * Setting writes live here, not in the RPC handlers, because the command
 * surface writes the same settings. One body means one validation message, one
 * log line and one routing-memory reset, whichever front end asked.
 */
export function writeBalancing(db: Database, enabled: boolean): WriteResult {
	setBalancingEnabled(db, enabled);
	// Turning routing back on starts from the order as it now stands; a trail
	// from before the switch describes another world.
	if (enabled) forgetRoutingMemory();
	recordLog("config", `automatic balancing ${enabled ? "on" : "off"}`);
	return {
		message: `Automatic balancing ${enabled ? "enabled" : "disabled"}.`,
		ok: true,
	};
}

export function writeBufferEnforcement(
	db: Database,
	value: string,
): WriteResult {
	if (value !== "always" && value !== "necessary") {
		return {
			message: `"${value}" is not when the buffer is enforced: give "always" or "necessary".`,
			ok: false,
		};
	}
	setBufferEnforcement(db, value);
	recordLog(
		"config",
		value === "necessary"
			? "buffer enforced only where it is needed"
			: "buffer always enforced",
	);
	return {
		message:
			value === "necessary"
				? "The buffer is enforced only when the limit has reached what the model holds."
				: "The buffer comes off every cut.",
		ok: true,
	};
}

export function writeContextBuffer(db: Database, value: string): WriteResult {
	const parsed = parseBuffer(value);
	if (!parsed.ok) return { message: parsed.message, ok: false };
	setBuffer(db, value);
	const stored = readBuffer(db);
	recordLog(
		"config",
		stored === undefined
			? "the compaction buffer follows the built-in rule again"
			: `the compaction buffer is ${stored}`,
	);
	return {
		message:
			stored === undefined
				? "the compaction buffer follows the built-in rule again."
				: `the compaction buffer is ${stored}.`,
		ok: true,
	};
}

export function writeContextLimit(db: Database, value: string): WriteResult {
	const parsed = parseLimit(value);
	if (!parsed.ok) return { message: parsed.message, ok: false };
	setLimit(db, value);
	const where =
		parsed.size && describeLimit(parsed.size, "the declared window");
	recordLog(
		"config",
		where ? `context limit ${where}` : "context limit back to the default",
	);
	return {
		message: where
			? `Context limit is ${where}.`
			: `Context limit is back to the default (${DEFAULT_PERCENT}% of the declared window).`,
		ok: true,
	};
}

export function writeModelLimit(
	db: Database,
	key: string,
	value: string,
): WriteResult {
	const parsed = parseLimit(value);
	if (!parsed.ok) return { message: parsed.message, ok: false };
	setModelLimit(db, key, value);
	const where = parsed.size && describeLimit(parsed.size, "its own window");
	recordLog(
		"config",
		where ? `${key} compacts at ${where}` : `${key} follows the global limit`,
	);
	return {
		message: where
			? `${key} compacts at ${where}.`
			: `${key} follows the global limit again.`,
		ok: true,
	};
}

export function writeRebalance(db: Database, value: string): WriteResult {
	const parsed = parseDuration(value);
	if (!parsed.ok) return { message: parsed.error, ok: false };
	setRebalance(db, value);
	// The field is authoritative over the switch in both directions: a length of
	// zero is the window being turned off, and any positive length is it being
	// turned back on. Otherwise the same field would mean two things depending on
	// which way it was last typed, and a length typed while the switch read
	// "off" would do nothing visible.
	const shut = parsed.ms !== undefined && parsed.ms <= 0;
	setRebalanceAuto(db, !shut);
	const ms = rebalanceAfterMs(db);
	recordLog(
		"config",
		ms > 0
			? `rebalance after ${formatDuration(ms)} idle`
			: "rebalance window off; a trail never goes stale on its own",
	);
	return {
		message:
			ms > 0
				? `A session starts over from the head after ${formatDuration(ms)} idle.`
				: "A trail no longer goes stale on its own; only a change to the order starts it over.",
		ok: true,
	};
}

export function writeRebalanceAuto(
	db: Database,
	enabled: boolean,
): WriteResult {
	if (!enabled) {
		setRebalanceAuto(db, false);
		recordLog(
			"config",
			"rebalance window off; a trail never goes stale on its own",
		);
		return {
			message:
				"A trail no longer goes stale on its own; only a change to the order starts it over.",
			ok: true,
		};
	}
	// Switching it on has to mean something: a stored zero would leave the toggle
	// on and the window still shut, so that length is cleared and the built-in
	// one comes back. Any other length is the user's and stays.
	const stored = readRebalance(db);
	const storedWindow = stored === undefined ? undefined : parseDuration(stored);
	if (
		storedWindow?.ok &&
		storedWindow.ms !== undefined &&
		storedWindow.ms <= 0
	) {
		setRebalance(db, "");
	}
	setRebalanceAuto(db, true);
	const ms = rebalanceAfterMs(db);
	recordLog("config", `rebalance after ${formatDuration(ms)} idle`);
	return {
		message: `A session starts over from the head after ${formatDuration(ms)} idle.`,
		ok: true,
	};
}
