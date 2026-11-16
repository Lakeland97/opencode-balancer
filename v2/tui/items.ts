/**
 * The panel's focus state is a list rebuilt every render. Keeping the index and
 * the grab in one value makes clamping and releasing a single reducer step,
 * rather than several signals that can disagree for a frame.
 */

export type Grab = { kind: "provider" } | { kind: "target"; key: string };

export type Cursor = { id?: string; index: number; grab?: Grab };

export function clampCursor(index: number, count: number) {
	return Math.max(0, Math.min(index, count - 1));
}

export function moveCursor(index: number, delta: number, count: number) {
	return clampCursor(index + delta, count);
}

export function pageCursor(
	index: number,
	deltaPages: number,
	count: number,
	pageSize: number,
) {
	return clampCursor(index + deltaPages * pageSize, count);
}

export function beginGrab(index: number, grab: Grab): Cursor {
	return { grab, index };
}

export function endGrab(cursor: Cursor): Cursor {
	return { id: cursor.id, index: cursor.index };
}

/** The slot a grab would move to, or undefined when it is already at an end. */
export function grabMove(
	cursor: Cursor,
	delta: number,
	count: number,
): number | undefined {
	if (!cursor.grab) return undefined;
	const next = cursor.index + delta;
	return next < 0 || next >= count ? undefined : next;
}

/**
 * Whether the panel should act on a key at all.
 *
 * The renderer's keyboard hook is global, so the panel has to prove it is the
 * focused surface before a space or an arrow can mean anything. A dialog owns
 * the keys while it is open, and a chord belongs to the host.
 */
export function panelOwnsKey(input: {
	ctrl: boolean;
	dialogOpen: boolean;
	focused: boolean;
	meta: boolean;
	option: boolean;
	super?: boolean;
}): boolean {
	return (
		input.focused &&
		!input.dialogOpen &&
		!input.ctrl &&
		!input.meta &&
		!input.option &&
		!input.super
	);
}
