import { describe, expect, test } from "bun:test";
import { bufferTokens, cutFor } from "../core/context";
import {
	credentialDetail,
	credentialNote,
	formatAgo,
	formatAttempt,
	routeMarkers,
	servingEntry,
} from "../core/format";
import type { Account, InUseEntry } from "../types";

function account(overrides: Partial<Account> = {}): Account {
	return {
		active: true,
		alias: "account-1",
		failures: 0,
		inUse: true,
		lastUsedAt: 0,
		limited: false,
		limitedReason: "",
		limitedUntil: 0,
		providerID: "open-design",
		...overrides,
	};
}

function served(overrides: Partial<InUseEntry> = {}): InUseEntry {
	return {
		agent: "build",
		alias: "account-1",
		applied: "high",
		at: new Date(2026, 10, 15, 11, 58).getTime(),
		familyKey: "deepseek",
		label: "DeepSeek Pro",
		modelID: "deepseek-v4.1-flash",
		providerID: "open-design",
		variant: "high",
		...overrides,
	};
}

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

describe("credential detail", () => {
	const now = new Date(2026, 10, 15, 12, 0).getTime();
	const until = new Date(2026, 10, 15, 14, 21).getTime();

	test("a park says the refill and the reason before anything else", () => {
		expect(
			credentialDetail({
				account: account({
					limited: true,
					limitedReason: "quota",
					limitedUntil: until,
				}),
				alias: "account-1",
				now,
				providerID: "open-design",
				resets: "resets",
				// Serving as well: the park still wins, because a credential that
				// cannot serve is the thing worth knowing.
				serving: [served()],
			}),
		).toBe("resets 14:21 · quota");
	});
	test("a serving credential names the model and when it served", () => {
		expect(
			credentialDetail({
				account: account(),
				alias: "account-1",
				now,
				providerID: "open-design",
				resets: "resets",
				serving: [served()],
			}),
		).toBe("build · open-design/deepseek-v4.1-flash (high) · 2m ago");
	});
	test("a credential that is neither parked nor serving has nothing to say", () => {
		expect(
			credentialDetail({
				account: account(),
				alias: "other",
				now,
				providerID: "open-design",
				resets: "resets",
				serving: [served()],
			}),
		).toBeUndefined();
		expect(
			credentialDetail({
				alias: "account-1",
				now,
				providerID: "open-design",
				resets: "resets",
			}),
		).toBeUndefined();
	});
	test("a second credential on the same provider is not the one serving", () => {
		expect(
			servingEntry(
				[served({ alias: "account-1" })],
				"open-design",
				"account-2",
			),
		).toBeUndefined();
		expect(
			servingEntry([served({ alias: "account-1" })], "open-design", "account-1")
				?.modelID,
		).toBe("deepseek-v4.1-flash");
	});
});

describe("time ago", () => {
	const now = new Date(2026, 10, 15, 12, 0).getTime();
	const ago = (ms: number) => formatAgo(now - ms, now);

	test("under a minute is just now", () => {
		expect(ago(0)).toBe("just now");
		expect(ago(44_000)).toBe("just now");
	});
	test("minutes, hours and days round to the nearest unit", () => {
		expect(ago(60_000)).toBe("1m ago");
		expect(ago(120_000)).toBe("2m ago");
		expect(ago(59 * 60_000)).toBe("59m ago");
		expect(ago(60 * 60_000)).toBe("1h ago");
		expect(ago(23 * 60 * 60_000)).toBe("23h ago");
		expect(ago(24 * 60 * 60_000)).toBe("1d ago");
		expect(ago(72 * 60 * 60_000)).toBe("3d ago");
	});
	test("a row with no moment has no ago words", () => {
		expect(formatAgo(0, now)).toBe("");
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
