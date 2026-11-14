import { beforeEach, describe, expect, test } from "bun:test";

import { clearLog, readLog, recordLog } from "../server/log";

beforeEach(() => {
	clearLog();
});

describe("balancer log", () => {
	test("keeps entries in the order they happened", () => {
		recordLog("route", "first", 1);
		recordLog("failover", "second", 2);

		expect(readLog()).toEqual([
			{ at: 1, kind: "route", text: "first" },
			{ at: 2, kind: "failover", text: "second" },
		]);
	});

	test("keeps only the most recent entries", () => {
		for (let index = 0; index < 250; index++)
			recordLog("route", String(index), index);

		const entries = readLog();
		expect(entries).toHaveLength(200);
		expect(entries[0]?.text).toBe("50");
		expect(entries[entries.length - 1]?.text).toBe("249");
	});

	test("clearing leaves nothing behind", () => {
		recordLog("error", "something went wrong");
		clearLog();
		expect(readLog()).toEqual([]);
	});
});
