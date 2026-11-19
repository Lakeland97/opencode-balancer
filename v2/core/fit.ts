/**
 * Cutting the oldest turns so a conversation fits a smaller window.
 *
 * The balancer declares one large window to the host, so the host never trims a
 * conversation by itself: it hands the whole thing to whichever target routing
 * chose. When the only healthy target has a smaller window than the conversation
 * has grown to, the request used to be refused or handed to a spent target with
 * a wider window. Cutting the head is the other way to make it fit, and it is
 * what the user asked for: keep the conversation running on the model that can
 * still answer it.
 *
 * The cut is by turn, never by message. A turn starts at a user message and
 * carries everything after it until the next user message — an assistant reply,
 * its tool calls and their results. Dropping from a turn boundary keeps those
 * pairs together, which is the one thing a conversation cannot survive losing:
 * a tool result whose call is gone is rejected outright by every provider.
 *
 * The instructions at the head are not conversation: leading system/developer
 * messages are always kept, and the newest turn is always kept even when it
 * alone is larger than the window. A request that cannot be made small enough is
 * sent as it is; the provider then names the real limit, which is more use to
 * the user than a conversation silently emptied.
 */

/** Characters per token, the same rough ratio the rest of the balancer uses. */
const CHARS_PER_TOKEN = 4;

/** Roles that carry instructions rather than turns of the conversation. */
const INSTRUCTION_ROLES = new Set(["developer", "system"]);

export type FittedConversation = {
	/** How many messages were removed from the head. */
	dropped: number;
	/** The messages that remain, instructions included. */
	messages: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleOf(message: unknown): string {
	if (!isRecord(message)) return "";
	const role = message.role;
	return typeof role === "string" ? role : "";
}

/** Roughly what one message costs, including the wrapper the wire adds. */
function messageTokens(message: unknown): number {
	return Math.ceil(JSON.stringify(message).length / CHARS_PER_TOKEN);
}

/**
 * A user message that carries only tool results.
 *
 * Anthropic-style connectors send a tool's result as a user message, so it looks
 * like a turn boundary while actually continuing the assistant's call. It is not
 * a place a conversation can open at, because the call it answers would be gone.
 */
function toolResultsOnly(message: unknown): boolean {
	if (roleOf(message) !== "user" || !isRecord(message)) return false;
	const content = message.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every((part) => isRecord(part) && part.type === "tool_result");
}

/**
 * The conversation with its oldest turns removed until it fits `budgetTokens`,
 * or undefined when there is nothing safe to remove or it already fits.
 *
 * `budgetTokens` is measured against the whole request, not just the messages:
 * the tools schema and the model fields are sent with every call and cannot be
 * cut, so the room they take is kept out of the budget before any turn is
 * considered.
 */
export function trimOldestTurns(
	body: unknown,
	budgetTokens: number,
): FittedConversation | undefined {
	if (!(budgetTokens > 0) || !isRecord(body)) return undefined;
	const messages = body.messages;
	if (!Array.isArray(messages) || messages.length < 2) return undefined;

	const sizes = messages.map(messageTokens);
	const conversation = sizes.reduce((sum, size) => sum + size, 0);
	const whole = Math.ceil(JSON.stringify(body).length / CHARS_PER_TOKEN);
	// Everything that is not a message: the tools, the model, the generation
	// settings. Only messages can go, so this part has to fit first.
	const fixed = Math.max(0, whole - conversation);
	if (fixed + conversation <= budgetTokens) return undefined;

	// The instructions at the head are not a turn and are never cut.
	let lead = 0;
	while (
		lead < messages.length &&
		INSTRUCTION_ROLES.has(roleOf(messages[lead]))
	) {
		lead += 1;
	}
	const instructions = sizes
		.slice(0, lead)
		.reduce((sum, size) => sum + size, 0);

	// Turn starts, newest last. A tool result is a continuation rather than a
	// turn, so it cannot be a start; the turn it belongs to began at the plain
	// user message before it, which is the point the cut has to respect.
	const turns: number[] = [];
	for (let index = lead; index < messages.length; index += 1) {
		const message = messages[index];
		if (roleOf(message) === "user" && !toolResultsOnly(message)) {
			turns.push(index);
		}
	}
	if (turns.length === 0) return undefined;

	// What the kept tail costs from each index onwards.
	const suffix = new Array<number>(messages.length + 1).fill(0);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		suffix[index] = (suffix[index + 1] ?? 0) + (sizes[index] ?? 0);
	}
	const costFrom = (index: number) =>
		fixed + instructions + (suffix[index] ?? 0);

	// The newest turn is always kept, even when it alone overflows: there is no
	// answer to give without the question that was just asked.
	let start = turns[turns.length - 1] ?? lead;
	for (let turn = turns.length - 2; turn >= 0; turn -= 1) {
		const candidate = turns[turn] ?? lead;
		// Earlier turns only add tokens, so the first one that overflows is where
		// the search stops rather than being skipped.
		if (costFrom(candidate) > budgetTokens) break;
		start = candidate;
	}

	// Nothing before the first turn can go: the conversation already starts at a
	// turn boundary and fits no better by removing instructions.
	if (start <= lead) return undefined;

	return {
		dropped: start - lead,
		messages: [...messages.slice(0, lead), ...messages.slice(start)],
	};
}
