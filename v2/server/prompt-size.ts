/**
 * The size of the instruction a compaction request carries, measured from the
 * request itself.
 *
 * Compacting sends the conversation plus a summarization instruction, and the
 * host appends that instruction as the last message. A session's compaction runs
 * on the row the session is routed through, so the balancer already sees the
 * request go past — which means the floor a reserve is held to can be measured
 * rather than assumed, and it follows the host if its prompt ever changes.
 *
 * The figure is rounded to the nearest thousand: the reserve is a coarse guard,
 * and letting the last digit move would only churn the stored value between
 * assessments. The host sends a short nudge in place of the instruction when a
 * reply skips its template; that is far under `MIN_INSTRUCTION_TOKENS`, so it is
 * not mistaken for the real thing and does not overwrite a measurement made from
 * one.
 */

/** Characters per token, the rough ratio the host's own estimator assumes. */
const CHARS_PER_TOKEN = 4;
/** What a measurement is rounded to, so the stored floor is a round figure. */
const PROMPT_STEP = 1_000;
/** Under this, the trailing message is the host's retry nudge, not the instruction. */
const MIN_INSTRUCTION_TOKENS = 200;

/** The instruction's size in tokens, or undefined when this is not one. */
export function summaryPromptTokens(body: unknown): number | undefined {
	const messages = messageList(body);
	if (messages.length === 0) return undefined;
	const last = messages[messages.length - 1] as
		| { content?: unknown; role?: unknown }
		| undefined;
	// The instruction is appended last. Anything else is a shape this does not
	// measure, which is not something to guess at.
	if (last?.role !== "user") return undefined;
	const text = messageText(last.content);
	if (text === "") return undefined;
	const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
	if (tokens < MIN_INSTRUCTION_TOKENS) return undefined;
	return Math.max(PROMPT_STEP, Math.round(tokens / PROMPT_STEP) * PROMPT_STEP);
}

/**
 * The instruction's size, measured from the request as it goes out. Undefined
 * when the body cannot be read, which leaves the last measurement standing rather
 * than clearing it.
 */
export async function summaryPromptTokensFrom(
	request: Request,
): Promise<number | undefined> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) return undefined;
	try {
		return summaryPromptTokens(JSON.parse(await request.clone().text()));
	} catch {
		return undefined;
	}
}

function messageList(body: unknown): unknown[] {
	if (!body || typeof body !== "object") return [];
	const messages = (body as { messages?: unknown }).messages;
	return Array.isArray(messages) ? messages : [];
}

/**
 * How large the prompt in this request is, in tokens.
 *
 * Routing has to know this before it picks a target: the host is told every
 * balancer model holds 1M tokens, so it never trims the conversation itself, and
 * a resumed session whose size the balancer never measured would be handed to a
 * target that cannot hold it. The body being sent is the ground truth for the
 * request in front of us, which is exactly what the choice needs.
 *
 * `content-length` answers without touching the stream; a transfer-encoded body
 * is read instead. The ratio is the same rough 4 characters per token the host's
 * own estimator uses, so the figure is comparable with every other size here.
 */
export async function promptTokensFrom(
	request: Request,
): Promise<number | undefined> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > 0) {
		return Math.round(declared / CHARS_PER_TOKEN);
	}
	try {
		return Math.round((await request.clone().text()).length / CHARS_PER_TOKEN);
	} catch {
		return undefined;
	}
}

/** A message's text, whether it is a string or the usual array of parts. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const text = (part as { text?: unknown } | undefined)?.text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}
