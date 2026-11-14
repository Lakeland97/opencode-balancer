import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { setLimit, setModelLimit } from "../core/context";
import { migrate } from "../core/schema";
import {
	type CompactionEvent,
	contextTokens,
	createCompactionController,
	type SessionTarget,
} from "../server/compaction";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}

const fiveFieldTokens = {
	cache: { read: 7, write: 1 },
	input: 10,
	output: 3,
	reasoning: 2,
};

function step(sessionID: string, tokens: unknown): CompactionEvent {
	return { data: { sessionID, tokens }, type: "session.step.ended" };
}

const TARGET: SessionTarget = {
	context: 1_000_000,
	familyKey: "deepseek-v4.1-flash",
	providerID: "p1",
};

/** One controller per harness, so the in-flight guard is the thing under test. */
function harness(db: Database, target: SessionTarget | undefined) {
	const compacted: string[] = [];
	const logs: string[] = [];
	const controller = createCompactionController({
		compact: async (sessionID) => {
			compacted.push(sessionID);
		},
		db,
		recordLog: (kind, text) => logs.push(`${kind}: ${text}`),
		resolve: () => target,
	});
	return {
		compacted,
		handle: (event: CompactionEvent) => controller.handle(event),
		logs,
	};
}

describe("what a request filled", () => {
	test("it sums every part of the usage, cache included", () => {
		// A cached prefix still occupies the prompt, so it is part of the fill.
		expect(contextTokens(fiveFieldTokens)).toBe(23);
	});

	test("missing detail counts as nothing rather than as a hole", () => {
		expect(contextTokens(undefined)).toBe(0);
		expect(contextTokens({})).toBe(0);
		expect(contextTokens({ input: 5 })).toBe(5);
		expect(contextTokens({ input: Number.NaN, output: 4 })).toBe(4);
	});
});

describe("when a conversation is compacted", () => {
	test("it compacts at the threshold and not below it", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, TARGET);

		expect(await handle(step("s1", { input: 199_999 }))).toBe(false);
		expect(compacted).toEqual([]);

		expect(await handle(step("s1", { input: 200_000 }))).toBe(true);
		expect(compacted).toEqual(["s1"]);
	});

	test("a conversation never routed here is left alone", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, undefined);

		expect(await handle(step("plain", { input: 5_000_000 }))).toBe(false);
		expect(compacted).toEqual([]);
	});

	test("a step that reports no usage does not compact at nothing", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, TARGET);

		expect(await handle(step("s1", undefined))).toBe(false);
		expect(compacted).toEqual([]);
	});

	test("the share is clamped by the model that is actually serving", async () => {
		const db = freshDb();
		setLimit(db, "30%");
		// 30% of the declared 1M is 300k, but this connector holds 200k, and the
		// cut stays a reserve below it so the compaction request itself fits.
		const { compacted, handle } = harness(db, { ...TARGET, context: 200_000 });

		expect(await handle(step("s1", { input: 179_999 }))).toBe(false);
		expect(await handle(step("s1", { input: 180_000 }))).toBe(true);
		expect(compacted).toEqual(["s1"]);
	});

	test("a model's own share overrides the global and measures its window", async () => {
		const db = freshDb();
		setLimit(db, "90%");
		setModelLimit(db, "deepseek-v4.1-flash", "50%");
		const { compacted, handle } = harness(db, { ...TARGET, context: 200_000 });

		// 50% of this model's own 200k is 100k, not 90% of the declared window.
		expect(await handle(step("s1", { input: 99_999 }))).toBe(false);
		expect(await handle(step("s1", { input: 100_000 }))).toBe(true);
		expect(compacted).toEqual(["s1"]);
	});

	test("the model's share follows the model, not the credential serving it", async () => {
		const db = freshDb();
		// Set while one credential served it; the other credential must not
		// compact the same model at the global share instead.
		setLimit(db, "90%");
		setModelLimit(db, "deepseek-v4.1-flash", "50%");
		const { handle } = harness(db, {
			...TARGET,
			context: 200_000,
			providerID: "p2",
		});

		expect(await handle(step("s1", { input: 99_999 }))).toBe(false);
		expect(await handle(step("s1", { input: 100_000 }))).toBe(true);
	});

	test("an unknown window still compacts on the share", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, {
			familyKey: "mystery",
			providerID: "p9",
		});

		expect(await handle(step("s1", { input: 200_000 }))).toBe(true);
		expect(compacted).toEqual(["s1"]);
	});
});

describe("one compaction per breach", () => {
	test("a second step past the threshold does not compact again", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, TARGET);

		await handle(step("s1", { input: 250_000 }));
		await handle(step("s1", { input: 260_000 }));
		await handle(step("s1", { input: 300_000 }));
		expect(compacted).toEqual(["s1"]);
	});

	test("a conversation back inside its window re-arms the check", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, TARGET);

		await handle(step("s1", { input: 250_000 }));
		// The compaction worked: the conversation is small again.
		await handle(step("s1", { input: 40_000 }));
		// Then it grows back past the threshold, which is a new breach.
		await handle(step("s1", { input: 250_000 }));

		expect(compacted).toEqual(["s1", "s1"]);
	});

	test("a compaction already running is not doubled", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, TARGET);

		// A manual compaction, or one the user asked for from another window.
		await handle({
			data: { sessionID: "s1" },
			type: "session.compaction.started",
		});
		expect(await handle(step("s1", { input: 900_000 }))).toBe(false);
		expect(compacted).toEqual([]);

		await handle({
			data: { sessionID: "s1" },
			type: "session.compaction.ended",
		});
		expect(await handle(step("s1", { input: 900_000 }))).toBe(true);
		expect(compacted).toEqual(["s1"]);
	});

	test("a compaction that failed can be tried again", async () => {
		const db = freshDb();
		const { compacted, handle } = harness(db, TARGET);

		await handle(step("s1", { input: 250_000 }));
		await handle({
			data: { sessionID: "s1" },
			type: "session.compaction.failed",
		});
		await handle(step("s1", { input: 250_000 }));

		expect(compacted).toEqual(["s1", "s1"]);
	});

	test("a compaction the host refuses is reported and can be retried", async () => {
		const db = freshDb();
		const compacted: string[] = [];
		const logs: string[] = [];
		const controller = createCompactionController({
			compact: async (sessionID) => {
				compacted.push(sessionID);
				throw new Error("session is busy");
			},
			db,
			recordLog: (kind, text) => logs.push(`${kind}: ${text}`),
			resolve: () => TARGET,
		});
		const handle = (event: CompactionEvent) => controller.handle(event);

		await handle(step("s1", { input: 250_000 }));
		expect(logs.some((line) => line.includes("session is busy"))).toBe(true);

		// The failure cleared the guard, so the next step tries again rather
		// than leaving the conversation with nothing protecting it.
		await handle(step("s1", { input: 250_000 }));
		expect(compacted).toEqual(["s1", "s1"]);
	});
});
