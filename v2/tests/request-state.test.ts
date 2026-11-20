import { describe, expect, test } from "bun:test";
import { isRetryableFailure } from "../server/request-state";

describe("failure classification", () => {
	test("a timeout worded as an abort still belongs to the account", () => {
		expect(
			isRetryableFailure({
				error: new Error("The operation was aborted due to timeout"),
			}),
		).toBe(true);
	});

	test("a timeout named by type is retryable even when the message says aborted", () => {
		const error = Object.assign(new Error("The operation was aborted"), {
			name: "TimeoutError",
		});
		expect(isRetryableFailure({ error })).toBe(true);
	});

	test("the user stopping the turn is not the account's fault", () => {
		expect(
			isRetryableFailure({ error: new Error("Aborted by the user") }),
		).toBe(false);
		expect(
			isRetryableFailure({ error: new Error("This operation was aborted") }),
		).toBe(false);
	});

	test("a context overflow is still the request's fault", () => {
		expect(isRetryableFailure({ error: new Error("prompt is too long") })).toBe(
			false,
		);
	});

	test("a billing refusal the host wrapped as InvalidRequest still fails over", () => {
		// The host has no specific mapping for the provider's refusal, so it
		// arrives as `AI.Error.InvalidRequest`. The wrapper's name is part of the
		// text, and it used to match the request-shaped rule before the account's
		// own words were read — handing a spent credential to the session instead
		// of moving to one that can still answer.
		const error = Object.assign(
			new Error(
				"You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
			),
			{ name: "InvalidRequest" },
		);
		expect(isRetryableFailure({ error })).toBe(true);
	});

	test("a genuine invalid request stays the request's fault under the same wrapper", () => {
		const error = Object.assign(
			new Error("invalid request: messages[0].role is required"),
			{ name: "InvalidRequest" },
		);
		expect(isRetryableFailure({ error })).toBe(false);
	});

	test("a model missing from the plan is not blamed on the account", () => {
		const error = Object.assign(new Error("model not found"), {
			name: "InvalidRequest",
		});
		expect(isRetryableFailure({ error })).toBe(false);
	});
});
