import type { Chain, Target } from "../types";
import type { BrandGroup } from "./models";

/**
 * Folding a polled row list into what the panel already has.
 *
 * The panel re-reads the rows every couple of seconds. Writing that answer
 * straight into the signal gave every row a new object on every poll, and a
 * renderer that keys rows by identity — Solid's `<For>`, and the TUI's list —
 * then tears the row down and builds it again. The damage is invisible until
 * somebody is inside a row: a native `<select>` closes the moment its element
 * leaves the document, so the model picker shut itself before a choice could be
 * made, and the add form it belonged to went with it.
 *
 * Two rows are therefore compared field by field, and an unchanged row keeps the
 * object it already had. The list itself is only replaced when something in it
 * actually moved.
 */

/** Whether two targets describe the same thing, sent the same way. */
function sameTarget(left: Target, right: Target) {
	return (
		left.providerID === right.providerID &&
		left.modelID === right.modelID &&
		// The name and window are shown on the row, so a connector that renamed
		// a model or reports a different window has to re-render.
		left.name === right.name &&
		left.context === right.context &&
		left.resolved === right.resolved &&
		left.state === right.state
	);
}

/**
 * Whether two reads of a row say the same thing.
 *
 * Every field is compared, because every field is shown: a row that stopped
 * substituting a free spelling, or whose target was parked, must re-render.
 */
export function sameChain(left: Chain, right: Chain) {
	return (
		left.key === right.key &&
		left.label === right.label &&
		left.package === right.package &&
		left.context === right.context &&
		left.limit === right.limit &&
		left.stored === right.stored &&
		left.targets.length === right.targets.length &&
		left.targets.every((target, index) => {
			const other = right.targets[index];
			return other !== undefined && sameTarget(target, other);
		})
	);
}

/**
 * The group headers to render, keeping the objects the panel already has.
 *
 * The rows are grouped into brand headers, and those headers are new objects on
 * every read. A renderer keyed by identity would then rebuild the header — and
 * every row inside it — whenever anything about any row changed, which closes a
 * picker that was open in one of them. A header whose brand and rows are
 * unchanged is therefore handed back as itself.
 */
export function mergeChainGroups(
	before: readonly BrandGroup<Chain>[],
	next: BrandGroup<Chain>[],
) {
	const unchanged =
		before.length === next.length &&
		before.every((group, index) => {
			const other = next[index];
			return (
				other !== undefined &&
				group.brand === other.brand &&
				group.rows.length === other.rows.length &&
				group.rows.every((row, at) => row === other.rows[at])
			);
		});
	return unchanged ? (before as BrandGroup<Chain>[]) : next;
}

export function mergeChainRows(rows: readonly Chain[], next: readonly Chain[]) {
	// Matched by key rather than by position, so a row that moved keeps its
	// object too: the renderer then moves the existing element instead of
	// rebuilding one that had a picker open in it.
	const before = new Map(rows.map((row) => [row.key, row]));
	let unchanged = rows.length === next.length;
	const merged = next.map((row, index) => {
		const previous = before.get(row.key);
		if (previous !== undefined && sameChain(previous, row)) {
			// A row that changed position still means the array has to be written.
			if (rows[index] !== previous) unchanged = false;
			return previous;
		}
		unchanged = false;
		return row;
	});
	// Returning the previous array is what lets the caller skip the signal write
	// entirely, so a poll that learned nothing schedules no work at all.
	return unchanged ? (rows as Chain[]) : merged;
}
