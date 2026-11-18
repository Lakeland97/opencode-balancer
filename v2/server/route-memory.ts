type Served = { at: number; modelID: string; providerID: string };

/** How long a "last served" note is meaningful for the panel. */
const SERVED_TTL_MS = 10 * 60_000;

/**
 * The target each row last sent to, per model family.
 *
 * The panel used to mark a provider "in use" from the single most recently
 * used credential, which is global: a row could show a provider that had served
 * some other model while the row's own traffic was going elsewhere. Routing
 * already knows the exact row and target, so it records them here.
 */
const served = new Map<string, Served>();
const tokens = new Map<string, { at: number; value: number }>();

export function noteServed(
	familyKey: string,
	route: { modelID: string; providerID: string },
	at: number = Date.now(),
) {
	served.set(familyKey, {
		at,
		modelID: route.modelID,
		providerID: route.providerID,
	});
}

/** The target this row last served with, or undefined when that is stale. */
export function servedFor(
	familyKey: string,
	at: number = Date.now(),
): Served | undefined {
	const entry = served.get(familyKey);
	if (!entry) return undefined;
	if (at - entry.at > SERVED_TTL_MS) {
		served.delete(familyKey);
		return undefined;
	}
	return entry;
}

/**
 * The conversation size the host last reported for a session. Routing uses it
 * so a failover never hands a conversation to a model with a smaller window
 * than the conversation already fills.
 */
export function noteSessionTokens(
	sessionID: string,
	value: number,
	at: number = Date.now(),
) {
	if (!Number.isFinite(value) || value < 0) return;
	tokens.set(sessionID, { at, value });
}

export function sessionTokens(
	sessionID: string,
	at: number = Date.now(),
): number | undefined {
	const entry = tokens.get(sessionID);
	if (!entry) return undefined;
	// A session the balancer has not heard from for a long time may have been
	// compacted elsewhere; forgetting it only costs a chance to overflow once.
	if (at - entry.at > SERVED_TTL_MS) {
		tokens.delete(sessionID);
		return undefined;
	}
	return entry.value;
}

export function forgetSessionTokens(sessionID: string) {
	tokens.delete(sessionID);
}

/** Tests share module state; this keeps one case's notes out of the next. */
export function resetRouteMemory() {
	served.clear();
	tokens.clear();
}
