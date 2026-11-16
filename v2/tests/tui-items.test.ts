import { describe, expect, test } from "bun:test";
import {
	beginGrab,
	clampCursor,
	endGrab,
	grabMove,
	moveCursor,
	pageCursor,
	panelOwnsKey,
} from "../tui/items";

describe("cursor", () => {
	test("the cursor clamps to the item list", () => {
		expect(clampCursor(5, 3)).toBe(2);
		expect(clampCursor(-1, 3)).toBe(0);
		expect(clampCursor(1, 0)).toBe(0);
		expect(moveCursor(0, -1, 3)).toBe(0);
		expect(moveCursor(2, 1, 3)).toBe(2);
		expect(moveCursor(1, 1, 3)).toBe(2);
	});
	test("a page moves by the page size and clamps", () => {
		expect(pageCursor(1, 1, 20, 5)).toBe(6);
		expect(pageCursor(18, 1, 20, 5)).toBe(19);
		expect(pageCursor(2, -1, 20, 5)).toBe(0);
	});
	test("a grab moves one slot and refuses the ends", () => {
		const cursor = beginGrab(1, { kind: "provider" });
		expect(grabMove(cursor, -1, 3)).toBe(0);
		expect(grabMove(cursor, 1, 3)).toBe(2);
		expect(
			grabMove({ grab: { kind: "provider" }, index: 0 }, -1, 3),
		).toBeUndefined();
		expect(endGrab({ ...cursor, id: "row:grip" }).grab).toBeUndefined();
		expect(endGrab({ ...cursor, id: "row:grip" }).id).toBe("row:grip");
	});
});

describe("panel keyboard scope", () => {
	const plain = {
		ctrl: false,
		dialogOpen: false,
		focused: true,
		meta: false,
		option: false,
	};
	test("only the focused panel without a dialog owns the keys", () => {
		expect(panelOwnsKey(plain)).toBe(true);
		expect(panelOwnsKey({ ...plain, focused: false })).toBe(false);
		expect(panelOwnsKey({ ...plain, dialogOpen: true })).toBe(false);
	});
	test("chords and modifiers belong to the host", () => {
		expect(panelOwnsKey({ ...plain, ctrl: true })).toBe(false);
		expect(panelOwnsKey({ ...plain, meta: true })).toBe(false);
		expect(panelOwnsKey({ ...plain, option: true })).toBe(false);
		expect(panelOwnsKey({ ...plain, super: true })).toBe(false);
	});
});
