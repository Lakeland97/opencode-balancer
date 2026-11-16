import { formatRollover } from "./rollover";

/** The words a credential's marker can carry, in render order. */
export type RouteMarker = "active" | "inUse" | "limited";

/**
 * The markers a credential earns. "in use" replaces "active" because the same
 * row cannot be both the one that served and merely able to serve; a park is
 * additive, because a credential can have served and then been parked.
 */
export function routeMarkers(input: {
	active: boolean;
	inUse: boolean;
	limited: boolean;
}): RouteMarker[] {
	const markers: RouteMarker[] = [];
	if (input.inUse) markers.push("inUse");
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
