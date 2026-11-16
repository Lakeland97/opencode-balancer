import { describe, expect, test } from "bun:test";
import {
	beginGrab,
	clampCursor,
	endGrab,
	grabMove,
	moveCursor,
	pageCursor,
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
		expect(endGrab(cursor).grab).toBeUndefined();
	});
});
