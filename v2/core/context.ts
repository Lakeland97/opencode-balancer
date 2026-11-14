export type CompactionBuffer =
	| { kind: "percent"; percent: number }
	| { kind: "tokens"; tokens: number }
	| { kind: "none" };

function clampReserve(percent: number): number {
	return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 0.99) : 0;
}

/**
 * Where the host will compact: the window a row declares, less the reserve the
 * config keeps free. `compaction.buffer` is that reserve, so a 51% buffer makes
 * the host compact at 49% of the declared window. The file is the setting; the
 * panel writes it rather than inventing a declaration to compensate for it.
 */
export function tripContext(
	realContext: number,
	buffer: CompactionBuffer,
): number {
	if (!(realContext > 0)) return 0;
	if (buffer.kind === "percent") {
		return Math.max(
			Math.ceil(realContext * (1 - clampReserve(buffer.percent))),
			0,
		);
	}
	if (buffer.kind === "tokens") {
		return Math.max(realContext - Math.max(buffer.tokens, 0), 0);
	}
	return realContext;
}

/**
 * The share of a window left to use, which is what the panel edits: the reserve
 * reads the other way round, so a 51% buffer is a 49% limit. A token reserve
 * has no single share, and no reserve means the whole window.
 */
export function targetShare(buffer: CompactionBuffer): number {
	if (buffer.kind === "percent") return 1 - clampReserve(buffer.percent);
	return 1;
}

function formatShare(fraction: number): string {
	return `${Number((fraction * 100).toFixed(2))}%`;
}

/**
 * How much the config keeps free, shown beside the limit so the relationship is
 * visible: the panel's percentage and this reserve are the same fact, twice.
 */
export function reserveLabel(buffer: CompactionBuffer): string {
	if (buffer.kind === "percent") return formatShare(buffer.percent);
	if (buffer.kind === "tokens") return `${buffer.tokens} tokens`;
	return "none";
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
