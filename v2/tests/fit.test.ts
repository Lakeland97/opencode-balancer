import { describe, expect, test } from "bun:test";

import { trimOldestTurns } from "../core/fit";

/**
 * A conversation shaped the way the host writes it: one system message and a
 * run of turns. Eight thousand characters is near two thousand tokens, which is
 * a big enough step to make the budget arithmetic obvious in a test.
 */
const said = (content: string) => ({ content, role: "user" });
const replied = (content: string) => ({ content, role: "assistant" });
const big = (label: string) => `${label}${"x".repeat(8_000)}`;

function body(...messages: unknown[]) {
	return { messages, model: "deepseek-v4.1-flash" };
}

const system = { content: "You are terse.", role: "system" };

describe("fitting a conversation to a smaller window", () => {
	test("drops the oldest turns and keeps the newest", () => {
		const conversation = body(
			system,
			said(big("one")),
			replied(big("two")),
			said(big("three")),
			replied(big("four")),
			said(big("five")),
			replied(big("six")),
		);

		// Room for the system message and one turn, not for two.
		const fitted = trimOldestTurns(conversation, 4_500);

		expect(fitted?.dropped).toBe(4);
		expect(fitted?.messages).toHaveLength(3);
		const kept = fitted?.messages as { content: string; role: string }[];
		expect(kept[0]).toEqual(system);
		expect(kept[1]?.content).toBe(big("five"));
		expect(kept[2]?.content).toBe(big("six"));
	});

	test("a cut lands on a turn boundary, never mid-turn", () => {
		const fitted = trimOldestTurns(
			body(
				said(big("one")),
				replied(big("two")),
				said(big("three")),
				replied(big("four")),
				said(big("five")),
				replied(big("six")),
			),
			4_500,
		);
		const kept = fitted?.messages as { role: string }[];
		// A turn starts with the user, so every kept turn has its question. An
		// assistant at the head would be an answer to a question that is gone.
		expect(kept[0]?.role).toBe("user");
		expect(fitted?.dropped).toBe(4);
	});

	test("a conversation that already fits is left untouched", () => {
		expect(trimOldestTurns(body(said("hello")), 200_000)).toBeUndefined();
	});

	test("a tool result never survives without the call that produced it", () => {
		const fitted = trimOldestTurns(
			body(
				said(big("one")),
				replied(big("two")),
				{
					content: [
						{ id: "call-1", input: {}, name: "read", type: "tool_use" },
					],
					role: "assistant",
				},
				{
					content: [
						{
							content: big("result"),
							tool_use_id: "call-1",
							type: "tool_result",
						},
					],
					role: "user",
				},
				replied(big("answer")),
			),
			4_500,
		);

		// Keeping the tool result would open the conversation with a result whose
		// call is gone, and the provider rejects that outright. The whole turn
		// goes instead, which here is the newest one, so nothing can be cut.
		expect(fitted).toBeUndefined();
	});

	test("a body with no conversation is not trimmed", () => {
		expect(trimOldestTurns({ model: "x" }, 10)).toBeUndefined();
		expect(trimOldestTurns(undefined, 10)).toBeUndefined();
		expect(trimOldestTurns(body(), 10)).toBeUndefined();
	});

	test("a single message is never dropped", () => {
		expect(trimOldestTurns(body(said(big("only"))), 10)).toBeUndefined();
	});

	test("the system message survives even when it alone fills the budget", () => {
		const fitted = trimOldestTurns(
			body(
				{ content: big("instructions"), role: "system" },
				said(big("one")),
				replied(big("two")),
				said(big("three")),
				replied(big("four")),
			),
			10,
		);
		const kept = fitted?.messages as { content: string; role: string }[];
		expect(kept[0]?.content).toBe(big("instructions"));
		expect(kept[1]?.content).toBe(big("three"));
		expect(kept[2]?.content).toBe(big("four"));
	});
});
