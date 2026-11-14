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

export type ModelMatch<T extends ModelCandidate> = {
	model: T;
	/** 4 id exact, 3 name exact, 2 id family, 1 name family. */
	score: number;
	/** Every candidate tied at the winning score, including the winner. */
	ties: readonly T[];
};

function score(query: string, candidate: ModelCandidate): number {
	const normalized = normalizeModel(query);
	const family = modelFamily(query);
	if (normalizeModel(candidate.modelID) === normalized) return 4;
	if (candidate.name && normalizeModel(candidate.name) === normalized) {
		return 3;
	}
	if (modelFamily(candidate.modelID) === family) return 2;
	if (candidate.name && modelFamily(candidate.name) === family) return 1;
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
