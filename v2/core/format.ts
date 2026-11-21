import type { Account, InUseEntry } from "../types";
import { formatRollover } from "./rollover";

/** The words a credential's marker can carry, in render order. */
export type RouteMarker = "active" | "inUse" | "pending" | "limited";

/**
 * The markers a credential earns. `pending` says the user picked this
 * credential and the next request will start on it; `in use` says it served
 * the most recent request. Pending replaces both because it is the newer
 * statement, and a park is additive: a credential can be picked and limited.
 */
export function routeMarkers(input: {
	active: boolean;
	inUse: boolean;
	limited: boolean;
	pending?: boolean;
}): RouteMarker[] {
	const markers: RouteMarker[] = [];
	if (input.pending) markers.push("pending");
	else if (input.inUse) markers.push("inUse");
	else if (input.active) markers.push("active");
	if (input.limited) markers.push("limited");
	return markers;
}

/**
 * What a parked credential's note says: the refill the endpoint named, then the
 * provider's own words. A park with neither has nothing to say and returns
 * undefined rather than an empty line.
 *
 * `resets` is passed in because both the GUI and the shared copy own that word
 * in their own way (`ctx.t("resets")` versus `copy.resets`); the note itself
 * stays one implementation.
 */
export function credentialNote(input: {
	limited: boolean;
	limitedUntil?: number;
	reason?: string;
	now?: number;
	resets: string;
}): string | undefined {
	if (!input.limited) return undefined;
	const parts = [
		input.limitedUntil
			? `${input.resets} ${formatRollover(input.limitedUntil, input.now ?? Date.now())}`
			: "",
		input.reason ?? "",
	].filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * How long ago something happened, in the words a credential's line wants.
 *
 * Naming the model being served without saying when it served reads as a claim
 * about right now, so the row that names it also says how long ago. The words
 * are deliberately coarse: a panel polling every couple of seconds needs to
 * distinguish "just happened" from "a while ago", not to the second.
 */
export function formatAgo(at: number, now: number = Date.now()) {
	if (!at) return "";
	const delta = Math.max(0, now - at);
	if (delta < 45_000) return "just now";
	const minutes = Math.round(delta / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * The one line that says what is serving: the agent, the connector's own model
 * id, and the rung that connector was actually asked for.
 *
 * Shared by both renderers and by command output, so the three surfaces cannot
 * drift. `agent` is `?` when the host did not name one — better than a blank
 * where a name belongs.
 */
export function servingText(input: {
	agent?: string;
	applied?: string;
	modelID: string;
	providerID: string;
}) {
	return `${input.agent || "?"} · ${input.providerID}/${input.modelID}${
		input.applied ? ` (${input.applied})` : ""
	}`;
}

/**
 * What a credential's note box says, under its name in the providers list.
 *
 * A park comes first, because a credential that cannot serve is the thing worth
 * knowing. Otherwise the box names the model this credential is serving and how
 * long ago it served — the only place either renderer shows that, now that the
 * panel has no status line of its own. A credential that is neither parked nor
 * serving has nothing to say, so the box stays out of the way entirely.
 */
export function credentialDetail(input: {
	account?: Account;
	/** The credential's own name, as its row lists it. */
	alias: string;
	providerID: string;
	/** The word the panel uses for a refill. */
	resets: string;
	/** Every row being served right now; this credential's is picked out here. */
	serving?: readonly InUseEntry[];
	now?: number;
}): string | undefined {
	const now = input.now ?? Date.now();
	// A park with no time in it says only what the provider said, if
	// anything; the refill is left out rather than invented.
	const note = credentialNote({
		limited: Boolean(input.account?.limited),
		limitedUntil:
			input.account?.limited && input.account.limitedUntil > 0
				? input.account.limitedUntil
				: undefined,
		now,
		reason: input.account?.limitedReason,
		resets: input.resets,
	});
	if (note) return note;
	const entry = servingEntry(input.serving, input.providerID, input.alias);
	if (!entry) return undefined;
	// A request still open is the row working, not idling: the timestamp is when
	// it last answered, which for a slow model is the whole of the wait.
	const line = servingText(entry);
	if (entry.working) return `${line} · working`;
	const ago = formatAgo(entry.at, now);
	return ago ? `${line} · ${ago}` : line;
}

/**
 * The row being served by one credential, when that credential is the one
 * serving it. Two credentials on one provider are two rows, so the pair is
 * what identifies a credential rather than the provider alone.
 */
export function servingEntry(
	serving: readonly InUseEntry[] | undefined,
	providerID: string,
	alias: string,
) {
	return (serving ?? []).find(
		(row) => row.providerID === providerID && row.alias === alias,
	);
}

/**
 * When a credential was last tried: the clock time when that was today, the
 * date too when it was older. A credential that has never been tried has no
 * time to show, and says so with a dash rather than an invented one.
 */
export function formatAttempt(at?: number) {
	if (!at) return "—";
	const date = new Date(at);
	const today = new Date();
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	const time = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}
