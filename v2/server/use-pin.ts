import type { Database } from "bun:sqlite";
import { now } from "../core/time";

/**
 * The credential the user picked with `use`: the row's head until another pick.
 *
 * `use` deliberately does not reorder providers — a credential picked for one
 * model must not become the first provider tried for every other model. That
 * made the pick invisible to routing, though: a stored row still walked its
 * chain from the top, and the sticky note from the last answer outranked the
 * pick, so the button looked like it did nothing whenever the row was already
 * serving somewhere else.
 *
 * The pin is the row's own memory of that choice. It is read before the sticky
 * note and the trail, so every request starts on the picked target while it can
 * serve; a refusal inside the request then fails over from there in the usual
 * way. It outlives a reload and is not erased by an answer — only by another
 * pick — because it is an instruction from the user, not a hint.
 */
export type UsePin = { providerID: string; alias: string; at: number };

const KEY = "use_pin";

function read(db: Database): UsePin | undefined {
	try {
		const value = db
			.query<{ value: string }, [string]>(
				"SELECT value FROM settings WHERE key = ?",
			)
			.get(KEY)?.value;
		if (value === undefined) return undefined;
		const pin = JSON.parse(value) as UsePin;
		return typeof pin?.providerID === "string" &&
			typeof pin?.alias === "string" &&
			typeof pin?.at === "number"
			? pin
			: undefined;
	} catch {
		return undefined;
	}
}

export function writeUsePin(
	db: Database,
	providerID: string,
	alias: string,
	at: number = now(),
) {
	try {
		db.query<unknown, [string, string]>(
			`INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		).run(KEY, JSON.stringify({ alias, at, providerID } satisfies UsePin));
	} catch {}
}

export function usePinFor(db: Database): UsePin | undefined {
	return read(db);
}

/** The next primary request is the one the pick was made for. */
export function takeUsePin(db: Database): UsePin | undefined {
	const pin = read(db);
	if (pin) clearUsePin(db);
	return pin;
}

export function clearUsePin(db: Database) {
	try {
		db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(KEY);
	} catch {}
}
