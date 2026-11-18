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
});
