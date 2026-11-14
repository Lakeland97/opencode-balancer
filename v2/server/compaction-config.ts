import {
	copyFileSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionBuffer } from "../core/context";

type CacheEntry = {
	mtimeMs: number;
	buffer: CompactionBuffer;
	auto: boolean | undefined;
};

const cache = new Map<string, CacheEntry>();

/** Turn a configured `compaction.buffer` into a fraction or a token count. */
export function parseBuffer(value: unknown): CompactionBuffer {
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0
			? { kind: "tokens", tokens: Math.round(value) }
			: { kind: "none" };
	}
	if (typeof value !== "string") return { kind: "none" };

	const match = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
	if (!match) return { kind: "none" };
	const percent = Number(match[1]) / 100;
	return percent > 0 && percent < 1
		? { kind: "percent", percent }
		: { kind: "none" };
}

/**
 * Strip JSONC comments and trailing commas. A character scanner, not a regex:
 * the config routinely contains `https://` URLs inside strings.
 */
export function stripJsonc(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	// String spans in output coordinates, so the trailing-comma pass can leave
	// text inside quotes alone.
	const strings: Array<[number, number]> = [];

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];

		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') {
				inString = false;
				const span = strings[strings.length - 1];
				if (span) span[1] = out.length;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			strings.push([out.length, out.length]);
			out += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index++;
			out += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (
				index < text.length &&
				!(text[index] === "*" && text[index + 1] === "/")
			)
				index++;
			index++;
			continue;
		}
		out += char;
	}

	return out.replace(/,(\s*[}\]])/g, (match, tail: string, offset: number) => {
		const quoted = strings.some(
			([start, end]) => offset >= start && offset < end,
		);
		return quoted ? match : tail;
	});
}

function candidatePaths(
	env: Record<string, string | undefined>,
	cwd: string,
): string[] {
	const home = env.HOME ?? homedir();
	const paths: string[] = [];
	if (env.OPENCODE_CONFIG) paths.push(env.OPENCODE_CONFIG);
	paths.push(join(cwd, "opencode.json"), join(cwd, "opencode.jsonc"));
	paths.push(
		join(home, ".config", "opencode", "opencode.json"),
		join(home, ".config", "opencode", "opencode.jsonc"),
	);
	return paths;
}

function readAt(path: string): CacheEntry | undefined {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return undefined;
	}

	const hit = cache.get(path);
	if (hit && hit.mtimeMs === mtimeMs) return hit;

	let entry: CacheEntry = {
		auto: undefined,
		buffer: { kind: "none" },
		mtimeMs,
	};
	try {
		const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as {
			compaction?: { auto?: unknown; buffer?: unknown };
		};
		const auto = parsed?.compaction?.auto;
		entry = {
			auto: typeof auto === "boolean" ? auto : undefined,
			buffer: parseBuffer(parsed?.compaction?.buffer),
			mtimeMs,
		};
	} catch {
		// A malformed config is no config, never a crash.
	}

	cache.set(path, entry);
	return entry;
}

/**
 * The effective compaction buffer. The plugin context exposes no config
 * accessor, so the files are read directly; the first file that actually
 * defines a buffer wins, which matches env > project > global layering.
 */
export function readCompactionBuffer(paths?: {
	env?: Record<string, string | undefined>;
	cwd?: string;
}): CompactionBuffer {
	const env = paths?.env ?? process.env;
	const cwd = paths?.cwd ?? process.cwd();

	for (const path of candidatePaths(env, cwd)) {
		const entry = readAt(path);
		if (entry && entry.buffer.kind !== "none") return entry.buffer;
	}
	return { kind: "none" };
}

/** Whether the host compacts on its own. Absent config means it does. */
export function getCompactionAutoEnabled(paths?: {
	env?: Record<string, string | undefined>;
	cwd?: string;
}): boolean {
	const env = paths?.env ?? process.env;
	const cwd = paths?.cwd ?? process.cwd();

	for (const path of candidatePaths(env, cwd)) {
		const entry = readAt(path);
		if (entry && entry.auto !== undefined) return entry.auto;
	}
	return true;
}

export function invalidateBufferCache() {
	cache.clear();
}

/**
 * The file that currently decides the buffer: the first that defines one, else
 * the first that exists, so a value can be added where nothing sets one yet.
 */ export function compactionConfigPath(paths?: {
	env?: Record<string, string | undefined>;
	cwd?: string;
}): string | undefined {
	const env = paths?.env ?? process.env;
	const cwd = paths?.cwd ?? process.cwd();
	const candidates = candidatePaths(env, cwd);

	for (const path of candidates) {
		const entry = readAt(path);
		if (entry && entry.buffer.kind !== "none") return path;
	}
	return candidates.find((path) => existsSync(path));
}

/** The buffer one specific file defines, ignoring the env/project/global layering. */
export function readBufferAt(path: string): CompactionBuffer {
	return readAt(path)?.buffer ?? { kind: "none" };
}

/**
 * Index just past the object or array that opens at `open`. Braces inside
 * strings and comments do not count, matching `stripJsonc`.
 */
function containerEnd(text: string, open: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = open; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index++;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (
				index < text.length &&
				!(text[index] === "*" && text[index + 1] === "/")
			)
				index++;
			index++;
			continue;
		}
		if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return text.length;
}

/**
 * The value forms the host accepts: a percentage from 1% to 99%, or a positive
 * token count. Anything else is refused rather than written and ignored.
 */
function normalizeBufferValue(value: string): string | number {
	const trimmed = value.trim();
	const percent = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
	if (percent) {
		const parsed = Number(percent[1]);
		if (parsed >= 1 && parsed <= 99) return `${percent[1]}%`;
		throw new Error(`buffer percent must be 1% to 99%, got "${value}"`);
	}
	if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) return Number(trimmed);
	throw new Error(
		`buffer must be a percent from 1% to 99% or a token count, got "${value}"`,
	);
}

/** Replace `compaction.buffer` in place, adding the key if the section lacks one. */
function withBufferValue(text: string, json: string): string {
	const section = /"compaction"\s*:\s*\{/.exec(text);
	if (!section) return withCompactionSection(text, json);

	const open = section.index + section[0].length - 1;
	const end = containerEnd(text, open);
	const region = text.slice(open, end);
	const existing = /"buffer"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/.exec(
		region,
	);

	if (!existing) {
		return `${text.slice(0, open + 1)}\n\t\t"buffer": ${json},${text.slice(open + 1)}`;
	}
	const from = open + existing.index;
	return `${text.slice(0, from)}"buffer": ${json}${text.slice(from + existing[0].length)}`;
}

/** The first `{` that opens a real object, skipping strings and comments. */
function firstObjectOpen(text: string): number {
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index++;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (
				index < text.length &&
				!(text[index] === "*" && text[index + 1] === "/")
			)
				index++;
			index++;
			continue;
		}
		if (char === "{") return index;
	}
	return -1;
}

/**
 * Add a `compaction` section holding the buffer when the config has none. The
 * member goes last in the root object, and the result is parsed again by the
 * caller before it is written, so a mistake here cannot reach the disk.
 */
function withCompactionSection(text: string, json: string): string {
	const open = firstObjectOpen(text);
	if (open < 0) throw new Error("the config is not a JSON object");

	const close = containerEnd(text, open) - 1;
	const before = text.slice(0, close);
	const needsComma = !/\{\s*$/.test(before);
	return `${before}${needsComma ? "," : ""}\n\t"compaction": {\n\t\t"buffer": ${json}\n\t}\n${text.slice(close)}`;
}

/**
 * Point the host's compaction buffer at a new value, or remove it when `value`
 * is undefined, editing the config in place so comments, formatting and every
 * other setting survive. The first write to a file keeps a `.bak` of the
 * original, and a malformed result is refused before anything lands on disk.
 */
export function writeCompactionBuffer(path: string, value: string | undefined) {
	const original = readFileSync(path, "utf8");
	const next =
		value === undefined
			? withoutBufferValue(original)
			: withBufferValue(original, JSON.stringify(normalizeBufferValue(value)));
	// Never persist text we cannot parse back.
	JSON.parse(stripJsonc(next));

	const backup = `${path}.bak`;
	if (!existsSync(backup)) copyFileSync(path, backup);
	const temp = `${path}.balancer.tmp`;
	writeFileSync(temp, next);
	renameSync(temp, path);
	invalidateBufferCache();
}

/** Drop `compaction.buffer` without disturbing the rest of the section. */
function withoutBufferValue(text: string): string {
	const section = /"compaction"\s*:\s*\{/.exec(text);
	if (!section) return text;

	const open = section.index + section[0].length - 1;
	const end = containerEnd(text, open);
	const region = text.slice(open, end);
	const existing = /"buffer"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/.exec(
		region,
	);
	if (!existing) return text;

	const from = open + existing.index;
	const valueEnd = from + existing[0].length;
	// A following comma is the usual case; a trailing one only when the key is
	// the last member. Removing either keeps the object valid.
	const after = /^\s*,/.exec(text.slice(valueEnd, end));
	if (after)
		return text.slice(0, from) + text.slice(valueEnd + after[0].length);

	const before = /,\s*$/.exec(text.slice(open, from));
	if (before) {
		return text.slice(0, open + before.index) + text.slice(valueEnd);
	}
	return text.slice(0, from) + text.slice(valueEnd);
}
