export type ModelCandidate = {
	modelID: string;
	name?: string;
};

/**
 * One spelling for a model across providers.
 *
 * Providers and catalogues disagree about the same model in several ways:
 * a provider namespace (`moonshotai/`, `z-ai/`), a `:free` tag, punctuation,
 * and capitalisation. Dots survive so a version such as `v4.1` stays one
 * token instead of collapsing into `v4-1`.
 */
export function normalizeModel(value: string): string {
	return value
		.toLowerCase()
		.replace(/^[^/]*\//, "")
		.replace(/:(?:free|paid|beta|preview)$/, "")
		.replace(/[^a-z0-9.]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * The model without its trailing build tag.
 *
 * The same model is re-tagged per provider with a date or build number
 * (`deepseek-v4.1-flash-1017`, `claude-haiku-4-5-20251001`), and the picker
 * shows that tag as part of the name. Dropping a trailing run of 4-8 digits
 * lets the tagged and untagged forms match, while names that merely end in a
 * version (`glm-5.3`, `claude-opus-4-8`) keep their identity.
 */
export function modelFamily(value: string): string {
	return normalizeModel(value).replace(/-\d{4,8}$/, "");
}

/**
 * The words a model name is made of, with the `v` providers put in front of a
 * version folded in: `v4.1` and `4.1` are the same word, so a person who types
 * the version without the letter is not asking for a different model.
 */
function modelWords(value: string): string[] {
	return modelFamily(value)
		.split("-")
		.filter(Boolean)
		.map((word) => word.replace(/^v(?=\d)/, ""));
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((word, index) => word === right[index])
	);
}

/**
 * Whether one word list begins the other. This is what lets `deepseek 4.1`
 * find `deepseek-v4.1-flash`, `-eco` and `-cloud` together: the query names
 * the family, and every variant is a tie the caller can report instead of
 * silently choosing.
 */
function startsWithWords(
	words: readonly string[],
	prefix: readonly string[],
): boolean {
	return (
		prefix.length > 0 &&
		prefix.length <= words.length &&
		prefix.every((word, index) => word === words[index])
	);
}

export type ModelMatch<T extends ModelCandidate> = {
	model: T;
	/** 4 id exact (including `v`/separator variants), 3 name exact, 2 id family, 1 name family or a family prefix. */
	score: number;
	/** Every candidate tied at the winning score, including the winner. */
	ties: readonly T[];
};

function score(query: string, candidate: ModelCandidate): number {
	const normalized = normalizeModel(query);
	const family = modelFamily(query);
	const words = modelWords(query);
	if (normalizeModel(candidate.modelID) === normalized) return 4;
	// The same identity with the provider's `v` and separators removed:
	// `deepseek 4.1 eco` is `deepseek-v4.1-eco`, not a weaker guess.
	if (sameWords(modelWords(candidate.modelID), words)) return 4;
	if (candidate.name && normalizeModel(candidate.name) === normalized) {
		return 3;
	}
	if (candidate.name && sameWords(modelWords(candidate.name), words)) {
		return 3;
	}
	if (modelFamily(candidate.modelID) === family) return 2;
	if (candidate.name && modelFamily(candidate.name) === family) return 1;
	// A person asking for `deepseek 4.1` means the family, not one of its
	// variants; every variant is a tie and the caller reports them.
	if (startsWithWords(modelWords(candidate.modelID), words)) return 1;
	if (candidate.name && startsWithWords(modelWords(candidate.name), words)) {
		return 1;
	}
	return 0;
}

/**
 * Finds the model a person meant, accepting either a provider's model id or the
 * label the picker shows. Returns the strongest match and every candidate tied
 * with it, so a genuinely ambiguous query can be reported instead of guessed.
 */
export function matchModel<T extends ModelCandidate>(
	query: string,
	candidates: readonly T[],
): ModelMatch<T> | undefined {
	let winner: { model: T; score: number } | undefined;
	let ties: T[] = [];

	for (const candidate of candidates) {
		const next = score(query, candidate);
		if (next === 0) continue;
		if (!winner || next > winner.score) {
			winner = { model: candidate, score: next };
			ties = [candidate];
			continue;
		}
		if (next === winner.score) ties.push(candidate);
	}

	return winner
		? { model: winner.model, score: winner.score, ties }
		: undefined;
}

/**
 * The candidates a query could mean when it did not name one exactly. A caller
 * that is about to route or store something must show these instead of taking
 * the first: `deepseek 4.1` describes three different models with three
 * different behaviours and prices.
 */
export function ambiguousModels<T extends ModelCandidate>(
	match: ModelMatch<T> | undefined,
): readonly T[] {
	return match && match.score < 4 && match.ties.length > 1 ? match.ties : [];
}

type CostTier = { input?: number; output?: number };

/**
 * Whether a model costs nothing to use. Connectors express this either as a
 * zero-priced tier or as a name marker (`-free`, `:free`), and the two do not
 * always agree, so both are accepted.
 */
export function isFreeModel(model: { cost?: unknown; modelID: string }) {
	if (/(^|[/:_-])free$/i.test(model.modelID)) return true;
	const tiers = Array.isArray(model.cost) ? (model.cost as CostTier[]) : [];
	// Missing pricing is unknown, not free: treating it as free would let a
	// free-only provider spend money on a model it was told to avoid.
	if (tiers.length === 0) return false;
	return tiers.every(
		(tier) => (tier.input ?? 0) <= 0 && (tier.output ?? 0) <= 0,
	);
}

/**
 * The brand a model's label belongs to, used to group rows in the panel. The
 * brand is the first word when the label has one (`Claude Fable 5.2`), and
 * otherwise whatever precedes the first hyphen (`GLM-5.3`, `gpt-5`). A version
 * that trails the brand (`Qwen3.7`) is dropped either way.
 */
export function modelBrand(label: string) {
	const first = label.trim().split(/\s+/)[0] ?? label;
	const head = first.split("-")[0] ?? first;
	const stripped = head.replace(/[\d.].*$/, "").replace(/[^A-Za-z]+$/, "");
	if (stripped.length >= 2) return stripped;
	return head.length > 0 ? head : first;
}

/**
 * Groups labelled rows under their brand, keeping the order inside each group
 * and sorting the groups case-insensitively.
 */
export type BrandGroup<T> = {
	/** Absent for a row that is the only one of its brand: it needs no header. */
	brand?: string;
	rows: T[];
};

/**
 * Groups labelled rows under their brand. Brands with more than one row come
 * first, alphabetically, then the lone rows in label order: a header over a
 * single row is noise.
 */
export function groupByBrand<T extends { label: string }>(
	rows: readonly T[],
): Array<BrandGroup<T>> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const brand = modelBrand(row.label);
		const list = groups.get(brand) ?? [];
		list.push(row);
		groups.set(brand, list);
	}

	const compare = (a: string, b: string) =>
		a.localeCompare(b, undefined, { sensitivity: "base" });

	const entered: Array<BrandGroup<T>> = [...groups.entries()]
		.filter(([, list]) => list.length > 1)
		.sort((a, b) => compare(a[0], b[0]))
		.map(([brand, list]) => ({ brand, rows: list }));

	const singles = [...groups.values()]
		.filter((list) => list.length === 1)
		.flat()
		.sort((a, b) => compare(a.label, b.label))
		.map((row) => ({ rows: [row] }));

	return [...entered, ...singles];
}
