import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	invalidateBufferCache,
	parseBuffer,
	readCompactionBuffer,
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
