import { describe, expect, test } from "bun:test";

import {
	type SyncTrigger,
	watchProviderChanges,
} from "../server/provider-watch";

type Wire = { push: (type: string) => void; close: () => void };

/**
 * An event stream the test drives one event at a time. It stays open until
 * `close`, so a watcher under test is waiting on real input rather than racing
 * an array that ends immediately.
 */
function channel(): { events: AsyncIterable<{ type: string }>; wire: Wire } {
	const queue: string[] = [];
	let wake: (() => void) | undefined;
	let closed = false;

	const events = (async function* () {
		while (true) {
			if (queue.length === 0) {
				if (closed) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			const next = queue.shift();
			if (next !== undefined) yield { type: next };
		}
	})();

	return {
		events,
		wire: {
			close: () => {
				closed = true;
				wake?.();
			},
			push: (type) => {
				queue.push(type);
				wake?.();
				wake = undefined;
			},
		},
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness() {
	const calls: SyncTrigger[] = [];
	const errors: unknown[] = [];
	const { events, wire } = channel();
	const done = watchProviderChanges(events, {
		cooldownMs: 60,
		debounceMs: 10,
		onError: (error) => errors.push(error),
		sync: async (trigger) => {
			calls.push(trigger);
		},
	});
	return { calls, done, errors, wire };
}

describe("watching provider changes", () => {
	test("a burst of provider events becomes one sync", async () => {
		const { calls, done, wire } = harness();
		wire.push("provider.updated");
		wire.push("provider.updated");
		wire.push("config.updated");
		await sleep(40);
		wire.close();
		await done;

		expect(calls).toEqual(["provider"]);
	});

	test("a credential change syncs at once, without waiting for the debounce", async () => {
		const { calls, done, wire } = harness();
		wire.push("credential.updated");
		wire.push("credential.switched");
		await sleep(5);
		wire.close();
		await done;

		expect(calls).toEqual(["credential", "credential"]);
	});

	test("the provider event our own reload emits is not followed", async () => {
		const { calls, done, wire } = harness();
		wire.push("provider.updated");
		await sleep(40);
		expect(calls).toEqual(["provider"]);

		// The echo arrives while the refresh it caused is still quiet.
		wire.push("provider.updated");
		wire.push("config.updated");
		await sleep(20);
		expect(calls).toEqual(["provider"]);

		// Once the cooldown has passed, a real change is followed again.
		await sleep(120);
		wire.push("provider.updated");
		await sleep(40);
		wire.close();
		await done;
		expect(calls).toEqual(["provider", "provider"]);
	});

	test("a failed sync does not stop the watcher", async () => {
		const errors: unknown[] = [];
		const calls: SyncTrigger[] = [];
		const { events, wire } = channel();
		const done = watchProviderChanges(events, {
			cooldownMs: 0,
			debounceMs: 5,
			onError: (error) => errors.push(error),
			sync: async (trigger) => {
				calls.push(trigger);
				if (calls.length === 1) throw new Error("sync failed");
			},
		});

		wire.push("provider.updated");
		await sleep(30);
		wire.push("provider.updated");
		await sleep(30);
		wire.close();
		await done;

		expect(errors).toHaveLength(1);
		expect(calls).toEqual(["provider", "provider"]);
	});
});
