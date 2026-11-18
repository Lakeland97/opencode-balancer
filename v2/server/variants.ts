/**
 * Thinking levels, which every provider names a little differently.
 *
 * The same model is offered with `low/medium/high` by one connector,
 * `none/low/high/max` by another, and `medium` may not exist at all. A row that
 * held one connector's list would offer a level another target cannot take, and
 * sending it through unchanged asked that provider for an effort it had never
 * advertised.
 *
 * The levels are therefore one ordered ladder from least to most, and a row
 * declares every level any of its targets offers. Sending a level a target does
 * not have maps to the nearest one it does, with a tie going to the lower rung:
 * `max` on a three-rung target is that target's top, `none` on a target that
 * starts at `low` is `low`. A name both sides share is used as itself, so
 * `high` means `high` wherever it exists.
 */

export type Variant = {
	id: string;
	settings?: Record<string, unknown>;
	body?: Record<string, unknown>;
};

/** Least to most effort. Unknown ids sort after these, by declaration order. */
const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

function rankOf(variant: Variant, index: number): number {
	const id = variant.id.toLowerCase();
	const known = EFFORT_ORDER.indexOf(id as (typeof EFFORT_ORDER)[number]);
	if (known >= 0) return known;
	// A provider that names its rungs something else (`thinking`, `default`)
	// still declares them in order, so the declaration is the ladder.
	return EFFORT_ORDER.length + index;
}

/**
 * One ladder for a row: every level any target offers, ordered least to most.
 *
 * The first target that offers a name owns its settings, which is what the row
 * declares to the host; sending it to another target goes through `mapVariant`,
 * so the settings the host applied are not assumed to fit.
 */
export function canonicalVariants(lists: readonly Variant[][]): Variant[] {
	const byID = new Map<string, Variant & { rank: number }>();
	let position = 0;
	for (const list of lists) {
		for (const variant of list) {
			const rank = rankOf(variant, position);
			position += 1;
			const existing = byID.get(variant.id);
			// A later spelling of the same rung can tighten the rank when an
			// unknown id turns out to be a known name elsewhere.
			if (!existing) byID.set(variant.id, { ...variant, rank });
			else if (rank < existing.rank) existing.rank = rank;
		}
	}
	return [...byID.values()]
		.sort((left, right) =>
			left.rank === right.rank
				? left.id.localeCompare(right.id)
				: left.rank - right.rank,
		)
		.map(({ id, settings, body }) => ({ body, id, settings }));
}

/**
 * The rung of `target` that means what `requested` asked for.
 *
 * An exact name wins, because providers agree on `low`/`high` often enough that
 * translating them would be inventing work. Otherwise the nearest rung wins,
 * measured on the effort ladder, and a tie goes to the lower one: overshooting a
 * thinking budget costs more and is harder to notice than undershooting it.
 */
export function mapVariant(
	requested: string | undefined,
	target: readonly Variant[],
): Variant | undefined {
	if (!requested || target.length === 0) return undefined;
	const exact = target.find((variant) => variant.id === requested);
	if (exact) return exact;

	const wanted = rankOf({ id: requested }, 0);
	let best: Variant | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const [index, variant] of target.entries()) {
		const distance = Math.abs(rankOf(variant, index) - wanted);
		if (
			distance < bestDistance ||
			// Ties go to the lower rung, and equal rungs keep declaration order.
			(distance === bestDistance &&
				best !== undefined &&
				rankOf(variant, index) < rankOf(best, index))
		) {
			best = variant;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * The body fields a variant turns into, for the wire formats this balancer can
 * speak. A connector may describe its rung as `settings` (the host applies them
 * itself) or as a literal `body`; either way the request already carries them.
 * Unknown settings are passed under their own name: a connector that understands
 * them will, and one that does not ignores them.
 */
function wireFields(variant: Variant | undefined) {
	const fields = new Map<string, unknown>();
	if (!variant) return fields;
	for (const value of [variant.settings, variant.body]) {
		if (!value) continue;
		for (const [key, entry] of Object.entries(value)) {
			if (key === "reasoningEffort") {
				fields.set("reasoning_effort", entry);
				continue;
			}
			fields.set(key, entry);
		}
	}
	return fields;
}

/**
 * Replace what the requested variant put in the body with what the target's own
 * rung puts there.
 *
 * The host applied the row's variant before the request reached this plugin, so
 * the body already carries that rung. A target that names the rung differently
 * gets the difference written over it, and a field only the row's rung set is
 * removed rather than left to be read as a level the target never agreed to.
 */
export function rewriteVariant(
	body: Record<string, unknown>,
	requested: Variant | undefined,
	target: Variant | undefined,
) {
	if (!requested || !target || requested.id === target.id) return body;

	const before = wireFields(requested);
	const after = wireFields(target);
	for (const key of before.keys()) {
		if (after.has(key)) continue;
		delete body[key];
		// A responses-style body nests the effort one level down.
		if (key === "reasoning_effort") {
			const reasoning = body.reasoning;
			if (reasoning && typeof reasoning === "object") {
				delete (reasoning as Record<string, unknown>).effort;
			}
		}
	}
	for (const [key, value] of after) {
		if (key === "reasoning_effort") {
			const reasoning = body.reasoning;
			if (reasoning && typeof reasoning === "object") {
				(reasoning as Record<string, unknown>).effort = value;
			} else if (key in body) {
				body[key] = value;
			}
			continue;
		}
		body[key] = value;
	}
	return body;
}
