import { describe, expect, test } from "bun:test";

import { isChatCatalogueEntry } from "../server/connectors";
import { parseCatalogue } from "../server/remote-models";

describe("a provider's own model catalogue", () => {
	test("the OpenAI shape is the shape every connector speaks", () => {
		const models = parseCatalogue({
			data: [
				{ created: 100, id: "claude-sonnet-5", object: "model" },
				{ id: "gpt-6.2-astra" },
			],
			object: "list",
		});

		expect(models?.map((model) => model.id)).toEqual([
			"claude-sonnet-5",
			"gpt-6.2-astra",
		]);
		expect(models?.[0].created).toBe(100);
	});

	test("a bare array is a catalogue too", () => {
		expect(parseCatalogue([{ id: "a" }, { id: "b" }])?.length).toBe(2);
	});

	test("an entry without an id is skipped, not guessed at", () => {
		const models = parseCatalogue({
			data: [{ id: "a" }, {}, { id: "" }, { name: "no id" }],
		});
		expect(models?.map((model) => model.id)).toEqual(["a"]);
	});

	test("the window is read from whichever field the provider used", () => {
		// The three shapes in use by the connectors this balancer talks to:
		// OpenAI has none, commandcode uses `context_length`, and open-design
		// nests it under `metadata`.
		const models = parseCatalogue({
			data: [
				{ id: "plain" },
				{ context_length: 200_000, id: "flat", max_output_tokens: 32_000 },
				{ id: "nested", metadata: { context_limit: 1_000_000 } },
				{ id: "limit", limit: { context: 105_000, output: 8_000 } },
			],
		});

		expect(
			models?.find((model) => model.id === "plain")?.context,
		).toBeUndefined();
		expect(models?.find((model) => model.id === "flat")?.context).toBe(200_000);
		expect(models?.find((model) => model.id === "flat")?.output).toBe(32_000);
		expect(models?.find((model) => model.id === "nested")?.context).toBe(
			1_000_000,
		);
		expect(models?.find((model) => model.id === "limit")?.context).toBe(
			105_000,
		);
	});

	test("a provider's own list drops what a chat row cannot send to", () => {
		// cline-pass publishes 464 ids, including batch endpoints and models that
		// are not chat at all. A row exists to take a chat request, so listing
		// them would create rows that can only fail. The test is on the filter,
		// not on the catalogue reader, which keeps everything the provider said.
		const ids = [
			"openai/gpt-6.2-astra",
			"openai/gpt-6.2-astra:batch",
			"openai/text-embedding-4",
			"openai/whisper-2",
			"openai/gpt-realtime-audio",
			"openai/gpt-image-gen-2",
		];
		expect(ids.filter(isChatCatalogueEntry)).toEqual(["openai/gpt-6.2-astra"]);
	});

	test("an error body is not a catalogue", () => {
		// commandcode answers an unknown route with a JSON error object; reading
		// that as an empty catalogue would look like "this provider has no
		// models", which is a different claim entirely.
		expect(
			parseCatalogue({
				message: "404 Not found. Check the docs for available routes.",
				status: 404,
				success: false,
			}),
		).toBeUndefined();
	});
});
