import { describe, expect, test } from "bun:test";
import { bufferTokens, cutFor } from "../core/context";
import { credentialNote, formatAttempt, routeMarkers } from "../core/format";

describe("route markers", () => {
	test("in use wins over active, and limited stays", () => {
		expect(routeMarkers({ active: true, inUse: true, limited: true })).toEqual([
			"inUse",
			"limited",
		]);
	});
	test("active is the fallback", () => {
		expect(
			routeMarkers({ active: true, inUse: false, limited: false }),
		).toEqual(["active"]);
	});
	test("a credential that cannot serve has no route marker", () => {
		expect(
			routeMarkers({ active: false, inUse: false, limited: false }),
		).toEqual([]);
	});
});

describe("credential note", () => {
	const now = new Date(2026, 10, 15, 12, 0).getTime();
	const until = new Date(2026, 10, 15, 14, 21).getTime();

	test("a live credential has no note", () => {
		expect(
			credentialNote({ limited: false, resets: "resets" }),
		).toBeUndefined();
	});
	test("the refill and the reason join with a dot", () => {
		expect(
			credentialNote({
				limited: true,
				limitedUntil: until,
				now,
				reason: "quota",
				resets: "resets",
			}),
		).toBe("resets 14:21 · quota");
	});
	test("a park with no words has no note", () => {
		expect(credentialNote({ limited: true, resets: "resets" })).toBeUndefined();
	});
});

describe("attempt time", () => {
	test("never tried is a dash", () => {
		expect(formatAttempt(0)).toBe("—");
	});
	test("a real attempt renders", () => {
		expect(formatAttempt(Date.now())).not.toBe("—");
	});
});

describe("cut", () => {
	test("always takes the buffer off", () => {
		expect(cutFor("200", "20", "always")).toBe(180_000);
	});
	test("necessary leaves a limit below the window alone", () => {
		expect(cutFor("200", "20", "necessary")).toBe(200_000);
	});
	test("empty settings use the built-in rule", () => {
		expect(cutFor("", "", "always")).toBe(180_000);
	});
	test("a share has no token size", () => {
		expect(bufferTokens("10%")).toBe(0);
	});
	test("a size reads in tokens", () => {
		expect(bufferTokens("20")).toBe(20_000);
	});
});
