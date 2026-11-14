export type CompactionBuffer =
	| { kind: "percent"; percent: number }
	| { kind: "tokens"; tokens: number }
	| { kind: "none" };

/**
 * The window a row declares so the host compacts where the smallest target in
 * the chain actually ends, not at a fraction of it.
 *
 * `compaction.buffer` is a share of the declared window, so a buffer of `p`
 * makes the host compact at `declared × (1 − p)`. Declaring `real / (1 − p)`
 * puts that trigger back on the real limit.
 *
 * `ceiling` is the largest real window in the row, and the declaration stops
 * there. The panel's `context limit` is a share of the model's own window — 20%
 * means "compact at 20% of what this model holds" — so a declaration past the
 * real window would have the host display a number no target in the row
 * actually has. A smaller target still compensates up to the ceiling, because
 * the row is allowed to route to the larger one.
 */
export function declaredContext(
	realContext: number,
	buffer: CompactionBuffer,
	ceiling: number,
): number {
	const declared = (() => {
		if (buffer.kind === "tokens") return realContext + buffer.tokens;
		if (buffer.kind === "percent") {
			const percent = Math.min(Math.max(buffer.percent, 0), 0.99);
			if (percent <= 0) return realContext;
			return Math.ceil(realContext / (1 - percent));
		}
		return realContext;
	})();
	return ceiling > 0 ? Math.min(declared, ceiling) : declared;
}

function formatShare(fraction: number): string {
	return `${Number((fraction * 100).toFixed(2))}%`;
}

/**
 * The share of a window left to use, which is what the panel shows: the host's
 * buffer is the part kept free, so a 20% buffer is an 80% limit. A token
 * reserve has no share to show and is reported as the token count it is.
 */
export function usableShare(buffer: CompactionBuffer): string {
	if (buffer.kind === "percent") return formatShare(1 - buffer.percent);
	if (buffer.kind === "tokens") return String(buffer.tokens);
	return "";
}

/**
 * The value to write for a share the user typed. A percentage becomes the
 * reserve the host wants — `80%` becomes `20%` — while a bare number over 99 is
 * a token count and is written as one.
 */
export function bufferFromShare(input: string): string {
	const typed = /^(\d+(?:\.\d+)?)(%?)$/.exec(input.trim());
	if (!typed) throw new Error(`"${input}" is not a share or a token count`);

	const value = Number(typed[1]);
	if (!typed[2] && value > 99) return String(value);

	const reserve = 100 - value;
	if (reserve < 1 || reserve > 99) {
		throw new Error(
			`the host keeps between 1% and 99% of a window free, so a share of "${input}" cannot be stored`,
		);
	}
	return formatShare(reserve / 100);
}

/**
 * The window across a row's targets: the smallest is what every hop must fit,
 * the largest is the most any hop can hold.
 */
export function rowWindow(
	targets: readonly { context?: number; output?: number }[],
): { ceiling: number; context: number; output: number } | undefined {
	const contexts = targets
		.map((target) => target.context)
		.filter((value): value is number => typeof value === "number" && value > 0);
	if (contexts.length === 0) return undefined;

	const outputs = targets
		.map((target) => target.output)
		.filter((value): value is number => typeof value === "number" && value > 0);

	return {
		ceiling: Math.max(...contexts),
		context: Math.min(...contexts),
		output: outputs.length > 0 ? Math.min(...outputs) : 0,
	};
}
