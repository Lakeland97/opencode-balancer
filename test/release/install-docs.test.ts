import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

describe("installation docs", () => {
	test("the V1 install guide recommends the unversioned package entry", () => {
		const installGuide = read("INSTALL.txt");
		// The V1 documentation moved to README-v1.md when the V2 README became the
		// repository's default, so the V1 wording is read from there.
		const readme = read("README-v1.md");

		expect(installGuide).toContain(
			"@thelioo/opencode-balancer (without @latest)",
		);
		expect(installGuide).not.toContain("@thelioo/opencode-balancer@latest");
		expect(readme).toContain(
			"Use the package name without an explicit `@latest` tag",
		);
		expect(readme).not.toContain(
			'"plugin": ["@thelioo/opencode-balancer@latest"]',
		);
	});
});
