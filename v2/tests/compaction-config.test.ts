import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compactionConfigPath,
	invalidateBufferCache,
	parseBuffer,
	readCompactionBuffer,
	stripJsonc,
	writeCompactionBuffer,
} from "../server/compaction-config";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "balancer-config-"));
}

describe("parseBuffer", () => {
	test("percent strings become fractions", () => {
		expect(parseBuffer("75%")).toEqual({ kind: "percent", percent: 0.75 });
	});

	test("decimal percents are preserved", () => {
		expect(parseBuffer("12.5%")).toEqual({ kind: "percent", percent: 0.125 });
	});

	test("integers are absolute token reservations", () => {
		expect(parseBuffer(20000)).toEqual({ kind: "tokens", tokens: 20000 });
	});

	test("nonsense is treated as no buffer", () => {
		expect(parseBuffer("abc")).toEqual({ kind: "none" });
		expect(parseBuffer(undefined)).toEqual({ kind: "none" });
		expect(parseBuffer("0%")).toEqual({ kind: "none" });
	});
});

describe("stripJsonc", () => {
	test("trailing commas are removed outside strings only", () => {
		const text =
			'{\n  "note": "keep,] and,} as written",\n  "list": [1, 2,],\n}';
		const parsed = JSON.parse(stripJsonc(text)) as {
			list: number[];
			note: string;
		};
		expect(parsed.list).toEqual([1, 2]);
		expect(parsed.note).toBe("keep,] and,} as written");
	});

	test("urls and comments survive", () => {
		const text = '{\n  // base\n  "u": "https://api.example/v1",\n}';
		expect(JSON.parse(stripJsonc(text))).toEqual({
			u: "https://api.example/v1",
		});
	});
});

describe("readCompactionBuffer", () => {
	test("reads a jsonc config with comments and trailing commas", () => {
		const cwd = tempDir();
		writeFileSync(
			join(cwd, "opencode.jsonc"),
			`{
  // project settings
  "model": "vendor/model",
  "compaction": {
    "auto": true,
    "buffer": "75%",
  },
}`,
		);
		const buffer = readCompactionBuffer({ cwd, env: { HOME: tempDir() } });
		expect(buffer).toEqual({ kind: "percent", percent: 0.75 });
	});

	test("a url inside the config is not mistaken for a comment", () => {
		const cwd = tempDir();
		writeFileSync(
			join(cwd, "opencode.json"),
			JSON.stringify({
				compaction: { buffer: "25%" },
				provider: { x: { options: { baseURL: "https://api.example/v1" } } },
			}),
		);
		expect(readCompactionBuffer({ cwd, env: { HOME: tempDir() } })).toEqual({
			kind: "percent",
			percent: 0.25,
		});
	});

	test("an unreadable file means no buffer", () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "opencode.json"), "{ not json");
		invalidateBufferCache();
		expect(readCompactionBuffer({ cwd, env: { HOME: tempDir() } })).toEqual({
			kind: "none",
		});
	});

	test("a file without a buffer falls through to the next one", () => {
		const cwd = tempDir();
		const home = tempDir();
		writeFileSync(join(cwd, "opencode.json"), '{"model":"x"}');
		const global = join(home, ".config", "opencode");
		require("node:fs").mkdirSync(global, { recursive: true });
		writeFileSync(
			join(global, "opencode.json"),
			'{"compaction":{"buffer":"40%"}}',
		);
		expect(readCompactionBuffer({ cwd, env: { HOME: home } })).toEqual({
			kind: "percent",
			percent: 0.4,
		});
	});

	test("a rewritten file is re-read after its mtime changes", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		writeFileSync(file, '{"compaction":{"buffer":"75%"}}');
		const env = { HOME: tempDir() };
		expect(readCompactionBuffer({ cwd, env })).toEqual({
			kind: "percent",
			percent: 0.75,
		});

		writeFileSync(file, '{"compaction":{"buffer":"50%"}}');
		const future = new Date(Date.now() + 5_000);
		utimesSync(file, future, future);
		expect(readCompactionBuffer({ cwd, env })).toEqual({
			kind: "percent",
			percent: 0.5,
		});
	});
});

describe("writeCompactionBuffer", () => {
	test("rewrites the value and leaves comments and other keys alone", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		writeFileSync(
			file,
			`{
  // keep this comment
  "model": "vendor/model",
  "provider": { "x": { "options": { "baseURL": "https://api.example/v1" } } },
  "compaction": {
    "auto": true,
    "buffer": "75%",
  },
}`,
		);

		writeCompactionBuffer(file, "1%");

		const text = readFileSync(file, "utf8");
		expect(text).toContain("// keep this comment");
		expect(text).toContain("https://api.example/v1");
		expect(text).toContain('"auto": true');
		expect(text).toContain('"buffer": "1%"');
		expect(text).not.toContain('"buffer": "75%"');
		expect(JSON.parse(stripJsonc(text))).toEqual({
			compaction: { auto: true, buffer: "1%" },
			model: "vendor/model",
			provider: { x: { options: { baseURL: "https://api.example/v1" } } },
		});
	});

	test("a token count is written as a number", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		writeFileSync(file, '{"compaction":{"buffer":"75%"}}');

		writeCompactionBuffer(file, "150000");

		expect(readFileSync(file, "utf8")).toContain('"buffer": 150000');
		expect(readCompactionBuffer({ cwd, env: { HOME: tempDir() } })).toEqual({
			kind: "tokens",
			tokens: 150000,
		});
	});

	test("the key is added when compaction has none", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		writeFileSync(file, '{\n  "compaction": {\n    "auto": true\n  }\n}');

		writeCompactionBuffer(file, "10%");

		expect(JSON.parse(stripJsonc(readFileSync(file, "utf8")))).toEqual({
			compaction: { auto: true, buffer: "10%" },
		});
	});

	test("refuses a value the host would reject, without touching the file", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		const original = '{"compaction":{"buffer":"75%"}}';
		writeFileSync(file, original);

		for (const bad of ["0%", "100%", "abc", "-5", ""]) {
			expect(() => writeCompactionBuffer(file, bad)).toThrow();
		}
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	test("keeps the original text as a backup", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		const original = '{"compaction":{"buffer":"75%"}}';
		writeFileSync(file, original);

		writeCompactionBuffer(file, "5%");

		expect(readFileSync(`${file}.bak`, "utf8")).toBe(original);
	});

	test("clearing removes only the buffer and keeps the section valid", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		writeFileSync(
			file,
			`{
  // keep this
  "compaction": {
    "auto": true,
    "buffer": "51%"
  },
  "model": "vendor/model"
}`,
		);

		writeCompactionBuffer(file, undefined);

		const text = readFileSync(file, "utf8");
		expect(text).toContain("// keep this");
		expect(text).not.toContain("buffer");
		expect(JSON.parse(stripJsonc(text))).toEqual({
			compaction: { auto: true },
			model: "vendor/model",
		});
	});

	test("clearing the last member of the section leaves no dangling comma", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		writeFileSync(
			file,
			'{\n  "model": "x",\n  "compaction": {\n    "auto": true,\n    "buffer": "51%"\n  }\n}',
		);

		writeCompactionBuffer(file, undefined);

		expect(JSON.parse(stripJsonc(readFileSync(file, "utf8")))).toEqual({
			compaction: { auto: true },
			model: "x",
		});
	});

	test("a buffer is added to a config with no compaction section", () => {
		const cwd = tempDir();
		const file = join(cwd, "opencode.json");
		writeFileSync(file, '{\n  // keep this\n  "model": "vendor/model"\n}');

		writeCompactionBuffer(file, "10%");

		const text = readFileSync(file, "utf8");
		expect(text).toContain("// keep this");
		expect(JSON.parse(stripJsonc(text))).toEqual({
			compaction: { buffer: "10%" },
			model: "vendor/model",
		});
	});
});

describe("compactionConfigPath", () => {
	test("prefers the file that decides the buffer", () => {
		const cwd = tempDir();
		const home = tempDir();
		const global = join(home, ".config", "opencode");
		require("node:fs").mkdirSync(global, { recursive: true });
		writeFileSync(join(cwd, "opencode.json"), '{"model":"x"}');
		const winning = join(global, "opencode.json");
		writeFileSync(winning, '{"compaction":{"buffer":"40%"}}');

		expect(compactionConfigPath({ cwd, env: { HOME: home } })).toBe(winning);
	});
});
