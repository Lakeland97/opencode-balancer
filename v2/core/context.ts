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
 */
export function declaredContext(
	realContext: number,
	buffer: CompactionBuffer,
): number {
	if (buffer.kind === "tokens") return realContext + buffer.tokens;
	if (buffer.kind === "percent") {
		const percent = Math.min(Math.max(buffer.percent, 0), 0.99);
		if (percent <= 0) return realContext;
		return Math.ceil(realContext / (1 - percent));
	}
	return realContext;
}

/** The smallest window across a row's targets, which is what every hop must fit. */
export function rowWindow(
	targets: readonly { context?: number; output?: number }[],
): { context: number; output: number } | undefined {
	const contexts = targets
		.map((target) => target.context)
		.filter((value): value is number => typeof value === "number" && value > 0);
	if (contexts.length === 0) return undefined;

	const outputs = targets
		.map((target) => target.output)
		.filter((value): value is number => typeof value === "number" && value > 0);

	return {
		context: Math.min(...contexts),
		output: outputs.length > 0 ? Math.min(...outputs) : 0,
	};
}
