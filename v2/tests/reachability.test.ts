import { afterEach, describe, expect, test } from "bun:test";
import { internetReachable, setInternetProbe } from "../server/reachability";

afterEach(() => setInternetProbe());

describe("internet reachability", () => {
	test("an unreachable DNS endpoint reports the internet down", async () => {
		setInternetProbe(async () => false);
		expect(await internetReachable()).toBe(false);
	});

	test("a reachable endpoint reports up, and is cached for the walk", async () => {
		let calls = 0;
		setInternetProbe(async () => {
			calls += 1;
			return true;
		});
		expect(await internetReachable()).toBe(true);
		expect(await internetReachable()).toBe(true);
		expect(calls).toBe(1);
	});
});
