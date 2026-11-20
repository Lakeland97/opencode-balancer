/**
 * Thinking levels, which every provider names a little differently.
 *
 * The picker offers three: `low`, `medium`, `high`. Providers do not agree on
 * that vocabulary — one has `none/low/high/max`, another `low/medium/high`,
 * another `minimal/.../xhigh` — so a row cannot offer one connector's list
 * without offering levels another target never advertised.
 *
 * Three levels are therefore the surface, and a target's own ladder is folded
 * onto their tail: its highest rung is what `high` means, the rung below that is
 * `medium`, and everything under it is `low`. A five-rung target reads
 * low/low/low/medium/high, so asking for `low` there does not buy a middle
 * effort the row never offered. A name both sides share is used as itself, so
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

/** The three levels the picker offers, least to most. */
const SURFACE = ["low", "medium", "high"] as const;

type Surface = (typeof SURFACE)[number];

/**
 * Which of the three a requested level means. Levels below `low` and above
 * `high` exist on providers, and a rung is folded onto the end it belongs to:
 * an old session asking for `max` gets the row's `high`, never a middle rung.
 */
function surfaceRank(id: string): number {
	const known = id.toLowerCase() as (typeof EFFORT_ORDER)[number];
	const index = EFFORT_ORDER.indexOf(known);
	if (index < 0) return 1;
	if (index <= EFFORT_ORDER.indexOf("low")) return 0;
	if (index >= EFFORT_ORDER.indexOf("high")) return 2;
	return 1;
}

/**
 * One ladder for a row: the three levels, carrying a target's own settings when
 * that target names the level itself.
 *
 * The first target that offers a name owns its settings, which is what the row
 * declares to the host; sending it to another target goes through `mapVariant`,
 * so the settings the host applied are not assumed to fit.
 */
export function canonicalVariants(lists: readonly Variant[][]): Variant[] {
	const offered = new Map<string, Variant>();
	for (const list of lists) {
		for (const variant of list) {
			const id = variant.id.toLowerCase();
			if (!SURFACE.includes(id as Surface)) continue;
			// A later spelling of the same rung adds nothing; the first target
			// that offered it is the one whose settings the host applies.
			if (!offered.has(id)) offered.set(id, variant);
		}
	}
	// Every level the surface offers is declared, even when no target named it:
	// the host refuses a session whose level is not in the row before this plugin
	// is asked, so a level carried from the previous model has to resolve here.
	// A target that names no level still receives none — `mapVariant` says so.
	return SURFACE.map((id) => offered.get(id) ?? { id });
}

/**
 * The rung of `target` that means what `requested` asked for.
 *
 * The mapping is positional, not name-based: a provider that calls its third
 * rung `high` has not thereby agreed that `high` means the same effort as
 * another provider's third rung. The target's ladder is folded onto the row's
 * three from the top — its last rung is `high`, the one before that `medium`,
 * and everything earlier is `low` — which is exactly the table a five-rung
 * target follows: 1/2/3 → low, 4 → medium, 5 → high. A ladder shorter than the
 * surface is spread across the three, rounding down, so a request never buys
 * more effort than it asked for.
 */
export function mapVariant(
	requested: string | undefined,
	target: readonly Variant[],
): Variant | undefined {
	if (!requested || target.length === 0) return undefined;

	const rank = surfaceRank(requested);
	if (target.length >= SURFACE.length) {
		const index = Math.min(
			target.length - 1,
			target.length - SURFACE.length + rank,
		);
		return target[index];
	}
	// A ladder shorter than the surface has no rung to spare: spread the three
	// across what exists, rounding towards the cheaper rung so a request never
	// buys more effort than it asked for.
	const index = Math.floor((rank * (target.length - 1)) / (SURFACE.length - 1));
	return target[index];
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
	// A target that names no rung has agreed to none, so the row's rung is
	// removed rather than sent to a provider that never advertised it.
	if (!requested) return body;

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
			} else {
				body[key] = value;
			}
			continue;
		}
		body[key] = value;
	}
	return body;
}
