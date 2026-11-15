import { describe, expect, test } from "bun:test";

import {
	summaryPromptTokens,
	summaryPromptTokensFrom,
} from "../server/prompt-size";

/** The host's own summary prompt, near enough: 2,541 characters when it was measured. */
const instruction = "x".repeat(2_541);
/** The reminder the host sends when a reply skips its template. */
const nudge =
	"The previous response did not fill in the required summary template.".repeat(
		2,
	);

function body(...messages: unknown[]) {
	return { messages, model: "deepseek-v4.1-flash" };
}

const said = (content: unknown) => ({ content, role: "user" });

describe("measuring the summary instruction", () => {
	test("it measures the instruction the host appends last, rounded to a thousand", () => {
		// 2,541 characters is near 640 tokens, which is the round figure the
		// reserve is held to.
		expect(summaryPromptTokens(body(said("hello"), said(instruction)))).toBe(
			1_000,
		);
	});

	test("a longer instruction raises the figure with it", () => {
		expect(summaryPromptTokens(body(said("x".repeat(8_000))))).toBe(2_000);
	});

	test("the host's retry nudge is not mistaken for the instruction", () => {
		// A measurement taken from the reminder would understate the room the next
		// compaction needs, so a short trailing message is not one.
		expect(
			summaryPromptTokens(body(said("hello"), said(nudge))),
		).toBeUndefined();
	});

	test("a trailing message that is not the user's is not measured", () => {
		expect(
			summaryPromptTokens(
				body(said(instruction), { content: "ok", role: "assistant" }),
			),
		).toBeUndefined();
	});

	test("content as parts measures the same as content as a string", () => {
		expect(
			summaryPromptTokens(
				body({ content: [{ text: instruction, type: "text" }], role: "user" }),
			),
		).toBe(1_000);
	});

	test("a body that is not a list of messages is not a measurement", () => {
		expect(summaryPromptTokens(undefined)).toBeUndefined();
		expect(summaryPromptTokens("a string")).toBeUndefined();
		expect(summaryPromptTokens(body())).toBeUndefined();
		expect(summaryPromptTokens(body({ role: "user" }))).toBeUndefined();
	});

	test("it reads the request the balancer hands it", async () => {
		const request = new Request(
			"https://balancer.invalid/v1/chat/completions",
			{
				body: JSON.stringify(body(said(instruction))),
				headers: { "content-type": "application/json" },
				method: "POST",
			},
		);
		expect(await summaryPromptTokensFrom(request)).toBe(1_000);
	});

	test("a body it cannot read leaves the last measurement standing", async () => {
		const request = new Request(
			"https://balancer.invalid/v1/chat/completions",
			{
				body: "not json",
				headers: { "content-type": "application/json" },
				method: "POST",
			},
		);
		expect(await summaryPromptTokensFrom(request)).toBeUndefined();
	});
});
