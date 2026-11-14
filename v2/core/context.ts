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
 * `ceiling` is the largest real window in the chain. Compensating a small
 * window can claim more than any target actually holds, which misreports the
 * row's reach in the picker and the context meter, so the declaration is capped
 * there. Compaction then fires slightly early, which is harmless.
 */
export function declaredContext(
	realContext: number,
	buffer: CompactionBuffer,
	ceiling?: number,
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
	return typeof ceiling === "number" && ceiling > 0
		? Math.min(declared, ceiling)
		: declared;
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
