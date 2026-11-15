import type { Database } from "bun:sqlite";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
	effectiveThreshold,
	readBufferEnforcement,
	readBufferSpec,
	readCompactPromptTokens,
	readLimitSpec,
	readModelLimitSpec,
} from "../core/context";
import { balancerTargetsFor, type SessionTarget } from "./hooks";
import { recordLog } from "./log";

/** The row and connector a session is running on, as the watcher needs it. */
export type { SessionTarget };

type TokenInfo = {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
};

/**
 * The tokens a request filled, which is what the model's window has to hold.
 * Cached tokens count: a cached prefix still occupies the prompt. This is the
 * same sum the host itself uses to show a session's context percentage, so the
 * balancer compacts at the point the host would have.
 */
export function contextTokens(tokens: TokenInfo | undefined): number {
	if (!tokens) return 0;
	const part = (value: number | undefined) =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	return (
		part(tokens.input) +
		part(tokens.output) +
		part(tokens.reasoning) +
		part(tokens.cache?.read) +
		part(tokens.cache?.write)
	);
}

/** One host event, as much of it as the decision needs. */
export type CompactionEvent = {
	type: string;
	data?: { sessionID?: unknown; tokens?: unknown };
};

/** A row the session has run, and the threshold its shares put it at. */
type Weighed = { target: SessionTarget; threshold: number };

/**
 * Decides when a conversation has filled its window and asks the host to
 * compact it.
 *
 * Kept separate from the event stream so the decision can be driven directly:
 * the stream is wiring, the guard is the part worth proving.
 */
export function createCompactionController(input: {
	db: Database;
	resolve: (sessionID: string) => SessionTarget[];
	compact: (sessionID: string) => Promise<unknown>;
	recordLog: (kind: "compact" | "error", text: string) => void;
}) {
	/** Sessions with a compaction in flight, so one breach compacts once. */
	const inFlight = new Set<string>();

	const thresholdFor = (target: SessionTarget) =>
		effectiveThreshold({
			buffer: readBufferSpec(input.db),
			bufferEnforcement: readBufferEnforcement(input.db),
			globalLimit: readLimitSpec(input.db),
			modelLimit: readModelLimitSpec(input.db, target.familyKey),
			// The measured summary-instruction size, so a reserve the user made tiny
			// still leaves the request that compacts this conversation somewhere to go.
			promptTokens: readCompactPromptTokens(input.db),
			realContext: target.context,
		});

	return {
		/** Feed one event. Returns true when it asked the host to compact. */
		async handle(event: CompactionEvent): Promise<boolean> {
			const sessionID =
				typeof event.data?.sessionID === "string" ? event.data.sessionID : "";
			if (!sessionID) return false;

			// The host compacts for its own reasons too, and a second compaction
			// running alongside the first would only fight it. A compaction is
			// "in flight" from the moment it starts until it ends or fails.
			if (event.type === "session.compaction.started") {
				inFlight.add(sessionID);
				return false;
			}
			if (
				event.type === "session.compaction.ended" ||
				event.type === "session.compaction.failed"
			) {
				inFlight.delete(sessionID);
				return false;
			}
			if (event.type !== "session.step.ended") return false;

			// A session the balancer has never routed is somebody else's
			// conversation, and its window is not the one we declared.
			const targets = input.resolve(sessionID);
			if (targets.length === 0) return false;

			// Every model the session has run, weighed, smallest first: a
			// conversation that moves between models has to fit all of them, so
			// the tightest window is the one that decides. Taking the newest
			// instead let a wide model's window govern a narrow model's request.
			const weighed: Weighed[] = targets
				.map((target) => ({ target, threshold: thresholdFor(target) }))
				.filter((entry) => entry.threshold > 0)
				.sort((left, right) => left.threshold - right.threshold);
			const tightest = weighed[0];
			if (!tightest) return false;

			const threshold = tightest.threshold;
			const tokens = contextTokens(event.data?.tokens as TokenInfo | undefined);
			if (tokens < threshold) {
				// Comfortably inside the window, which also means a compaction
				// that was in flight has served its purpose as a guard.
				inFlight.delete(sessionID);
				return false;
			}
			if (inFlight.has(sessionID)) return false;

			inFlight.add(sessionID);
			input.recordLog(
				"compact",
				`${tightest.target.familyKey} reached ${tokens} of ${threshold} tokens; compacting`,
			);
			try {
				await input.compact(sessionID);
			} catch (error) {
				// The guard comes off so the next step can try again: a refused
				// compaction must not leave the conversation with nothing
				// protecting it.
				inFlight.delete(sessionID);
				input.recordLog(
					"error",
					`compaction failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			return true;
		},
	};
}

/**
 * Watch the host's own events and compact a routed session when its row
 * reaches the threshold its shares put it at.
 */
export async function registerCompaction({
	ctx,
	db,
}: {
	ctx: Context;
	db: Database;
}) {
	const controller = createCompactionController({
		compact: (sessionID) => ctx.session.compact({ sessionID }),
		db,
		recordLog,
		resolve: balancerTargetsFor,
	});

	void (async () => {
		try {
			for await (const event of ctx.event.subscribe({
				types: [
					"session.step.ended",
					"session.compaction.started",
					"session.compaction.ended",
					"session.compaction.failed",
				],
			})) {
				try {
					await controller.handle(event as unknown as CompactionEvent);
				} catch (error) {
					recordLog(
						"error",
						`compaction check failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		} catch {
			// The event stream ended; nothing more to watch this run.
		}
	})();
}
