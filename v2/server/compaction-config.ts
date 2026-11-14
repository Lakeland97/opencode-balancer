import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionBuffer } from "../core/context";

type CacheEntry = { mtimeMs: number; buffer: CompactionBuffer };

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
function stripJsonc(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];

		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
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

	return out.replace(/,(\s*[}\]])/g, "$1");
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

function readBufferAt(path: string): CompactionBuffer {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return { kind: "none" };
	}

	const hit = cache.get(path);
	if (hit && hit.mtimeMs === mtimeMs) return hit.buffer;

	let buffer: CompactionBuffer = { kind: "none" };
	try {
		const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as {
			compaction?: { buffer?: unknown };
		};
		buffer = parseBuffer(parsed?.compaction?.buffer);
	} catch {
		buffer = { kind: "none" };
	}

	cache.set(path, { buffer, mtimeMs });
	return buffer;
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
		const buffer = readBufferAt(path);
		if (buffer.kind !== "none") return buffer;
	}
	return { kind: "none" };
}

export function invalidateBufferCache() {
	cache.clear();
}
