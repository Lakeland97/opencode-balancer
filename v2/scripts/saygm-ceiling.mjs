#!/usr/bin/env node
/**
 * SayGM price gate: keep the balancer off models priced above a ceiling you set.
 *
 * This is a compat script on purpose. It is not imported by the plugin, it does
 * not change how the plugin is built, and it can be deleted without touching a
 * single source file. It is a rudimentary "don't spend above X per token" check:
 * read SayGM's public catalogue, and for every routable model whose price is
 * above the ceiling write the same `model_unavailable:<pair>` mark the plugin
 * writes when a provider refuses a model. Routing already treats that mark as
 * "nothing can be sent here", so the effect is immediate and needs no reload.
 *
 * Two rules make it safe to run repeatedly:
 *
 *   - It only clears marks it wrote. A pair the plugin marked after a real
 *     refusal keeps its mark; the manifest in `settings` records what this
 *     script owns.
 *   - It renews its own marks on every run. A mark is a lease, not a verdict:
 *     if the script stops running, or you raise the ceiling, the pairs come back
 *     on their own instead of staying blocked forever.
 *
 * Usage:
 *   node saygm-ceiling.mjs --under 0.50
 *   node saygm-ceiling.mjs --under 1.00 --dimension output --basis floor
 *   node saygm-ceiling.mjs --under 0.75 --dimension input,output --dry-run
 *   node saygm-ceiling.mjs --under 0.50 --watch 300
 *
 * Requires nothing but Node (>= 22) or Bun. The database driver is picked from
 * what is available: `bun:sqlite`, then `node:sqlite`, then the `sqlite3` CLI.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFIX = "model_unavailable:";
const MANIFEST = "saygm_ceiling:written";
const DEFAULT_PROVIDER = "saygm";
const DEFAULT_BASIS = "route_ceiling";
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

/** Every dimension the catalogue can price, in the order a report shows them. */
const DIMENSIONS = [
	"input",
	"output",
	"cache_read",
	"cache_write_5m",
	"cache_write_1h",
];

const HELP = `SayGM price gate

  --under <usd>          ceiling in dollars per million tokens (required)
  --dimension <name>     input, output, cache_read, cache_write_5m,
                         cache_write_1h; comma-separated; default input
  --basis <name>         which published number to compare: route_ceiling
                         (default), floor, or ceiling
  --provider <id>        provider id the marks belong to (default ${DEFAULT_PROVIDER})
  --db <path>            balancer.sqlite to write (default: OpenCode's config dir)
  --ttl <minutes>        how long a mark is kept before it lapses (default 360)
  --list                 print the catalogue and the decision, write nothing
  --dry-run              print what would change, write nothing
  --watch <seconds>      keep running, re-reading the catalogue each pass
  --json                 print one JSON report per pass instead of lines
  --help                 this text

Exit status is 1 when the catalogue or the database could not be used.`;

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = {
		basis: DEFAULT_BASIS,
		db: undefined,
		dimensions: ["input"],
		dryRun: false,
		json: false,
		list: false,
		provider: DEFAULT_PROVIDER,
		ttlMinutes: DEFAULT_TTL_MS / 60_000,
		under: undefined,
		watchSeconds: 0,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				fail(`${arg} needs a value`);
			}
			index += 1;
			return value;
		};
		switch (arg) {
			case "--under": {
				const value = Number(next());
				if (!Number.isFinite(value) || value < 0)
					fail("--under must be a dollar amount, e.g. 0.50");
				options.under = value;
				break;
			}
			case "--dimension":
			case "--dimensions": {
				const names = next()
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean);
				if (names.length === 0) fail("--dimension needs at least one name");
				options.dimensions = names.map(normalizeDimension);
				break;
			}
			case "--basis": {
				const value = next();
				if (!["floor", "route_ceiling", "ceiling"].includes(value)) {
					fail("--basis must be floor, route_ceiling, or ceiling");
				}
				options.basis = value;
				break;
			}
			case "--provider":
				options.provider = next();
				break;
			case "--db":
				options.db = next();
				break;
			case "--ttl": {
				const value = Number(next());
				if (!Number.isFinite(value) || value <= 0)
					fail("--ttl must be a positive number of minutes");
				options.ttlMinutes = value;
				break;
			}
			case "--list":
				options.list = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--watch": {
				const value = Number(next());
				if (!Number.isFinite(value) || value <= 0)
					fail("--watch must be a positive number of seconds");
				options.watchSeconds = value;
				break;
			}
			case "--json":
				options.json = true;
				break;
			case "--help":
			case "-h": {
				process.stdout.write(`${HELP}\n`);
				process.exit(0);
				break;
			}
			default:
				fail(`unknown argument ${arg}\n\n${HELP}`);
		}
	}

	if (options.under === undefined && !options.list) {
		fail(`--under is required\n\n${HELP}`);
	}
	// The catalogue keys carry the unit, so the default has to as well.
	options.dimensions = options.dimensions.map(normalizeDimension);
	return options;
}

/** Accept `input`, `input_per_mtok_ndollars`, or a pasted catalogue key. */
function normalizeDimension(name) {
	const bare = name.replace(/_per_mtok_ndollars$/, "").replace(/-/g, "_");
	if (!DIMENSIONS.includes(bare)) {
		fail(`unknown dimension ${name}; expected one of ${DIMENSIONS.join(", ")}`);
	}
	return `${bare}_per_mtok_ndollars`;
}

/** The balancer's store, resolved the same way the plugin resolves it. */
function storePath(explicit) {
	if (explicit) return explicit;
	const config =
		process.env.OPENCODE_CONFIG_DIR ||
		join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
	return join(config, "balancer.sqlite");
}

/**
 * A tiny store adapter over whichever driver exists. All three speak the same
 * two operations this script needs, and each opens the database read-write so a
 * mark written here is the mark routing reads.
 */
async function openStore(path) {
	if (!existsSync(path)) fail(`no balancer store at ${path}`);

	try {
		const { Database } = await import("bun:sqlite");
		const db = new Database(path);
		db.exec("PRAGMA busy_timeout = 5000");
		return {
			all: (sql, ...params) => db.query(sql).all(...params),
			close: () => db.close(),
			driver: "bun:sqlite",
			run: (sql, ...params) => db.query(sql).run(...params),
		};
	} catch {}

	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(path);
		db.exec("PRAGMA busy_timeout = 5000");
		return {
			all: (sql, ...params) => db.prepare(sql).all(...params),
			close: () => db.close(),
			driver: "node:sqlite",
			run: (sql, ...params) => db.prepare(sql).run(...params),
		};
	} catch {}

	return openSqliteCLI(path);
}

/**
 * The CLI dialect: no parameters, so values are quoted here. Only this script's
 * own keys and JSON blobs pass through, and a single quote is doubled the way
 * SQL expects, so a model id cannot break out of its literal.
 */
async function openSqliteCLI(path) {
	const { execFileSync } = await import("node:child_process");
	const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
	const query = (sql) =>
		execFileSync("sqlite3", ["-batch", "-json", path, sql], {
			encoding: "utf8",
		});
	const statement = (sql) =>
		execFileSync("sqlite3", ["-batch", path, sql], { encoding: "utf8" });

	// Fail early and clearly when the CLI is not installed.
	try {
		statement("PRAGMA busy_timeout = 5000");
	} catch (error) {
		fail(
			`no usable database driver: bun:sqlite and node:sqlite both failed, and the sqlite3 CLI did not run (${error.message})`,
		);
	}

	return {
		all: (sql, ...params) => {
			const filled = sql.replace(/\?/g, () => quote(params.shift()));
			const text = query(filled).trim();
			return text === "" ? [] : JSON.parse(text);
		},
		close: () => {},
		driver: "sqlite3",
		run: (sql, ...params) => {
			const filled = sql.replace(/\?/g, () => quote(params.shift()));
			statement(filled);
		},
	};
}

function hasSettingsTable(store) {
	try {
		return (
			store.all(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
			).length > 0
		);
	} catch {
		return false;
	}
}

function readSetting(store, key) {
	const rows = store.all("SELECT value FROM settings WHERE key = ?", key);
	return rows.length === 0 ? undefined : rows[0].value;
}

function writeSetting(store, key, value) {
	store.run(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key,
		value,
	);
}

function deleteSetting(store, key) {
	store.run("DELETE FROM settings WHERE key = ?", key);
}

function pairKey(providerID, modelID) {
	return JSON.stringify([providerID, modelID]);
}

function markKey(providerID, modelID) {
	return `${PREFIX}${pairKey(providerID, modelID)}`;
}

function readManifest(store) {
	const raw = readSetting(store, MANIFEST);
	if (raw === undefined) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(entry) =>
					Array.isArray(entry) &&
					typeof entry[0] === "string" &&
					typeof entry[1] === "string",
			)
			.map((entry) => [entry[0], entry[1]]);
	} catch {
		return [];
	}
}

/** Dollars per million tokens from the catalogue's integer nano-dollars. */
function dollars(ndollars) {
	return typeof ndollars === "number" && Number.isFinite(ndollars)
		? ndollars / 1e9
		: undefined;
}

function priceOf(model, basis, dimension) {
	const range = model.price_range?.[basis];
	return dollars(range?.dimensions?.[dimension]);
}

async function fetchCatalogue() {
	const response = await fetch("https://api.saygm.com/v1/models", {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`catalogue answered ${response.status}`);
	}
	const body = await response.json();
	const data = Array.isArray(body) ? body : (body.data ?? body.models);
	if (!Array.isArray(data)) throw new Error("catalogue has no model list");
	return data;
}

/**
 * Decide what the ceiling implies for one model. A model the provider itself
 * calls unavailable is left alone: it is already not routable, and a mark here
 * would only blur which of the two reasons applies.
 */
function decide(model, options) {
	if (model.available === false || model.coming_soon === true) {
		return { action: "skip", reason: "not offered" };
	}
	let worst;
	for (const dimension of options.dimensions) {
		const price = priceOf(model, options.basis, dimension);
		if (price === undefined) continue;
		if (worst === undefined || price > worst.price) {
			worst = { dimension, price };
		}
	}
	if (worst === undefined) return { action: "skip", reason: "unpriced" };
	return worst.price > options.under
		? { action: "block", dimension: worst.dimension, price: worst.price }
		: { action: "allow", dimension: worst.dimension, price: worst.price };
}

function formatDollars(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
	return `$${value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2)}`;
}

function report(reportData, options) {
	if (options.json) {
		process.stdout.write(`${JSON.stringify(reportData)}\n`);
		return;
	}
	const lines = [];
	const dimensions = options.dimensions
		.map((name) => name.replace(/_per_mtok_ndollars$/, ""))
		.join(", ");
	lines.push(
		options.under === undefined
			? `${reportData.blocked.length} blocked, ${reportData.allowed} allowed, ${reportData.skipped} skipped · ${dimensions} at ${options.basis}`
			: `${reportData.blocked.length} blocked, ${reportData.allowed} allowed, ${reportData.skipped} skipped · ceiling ${formatDollars(options.under)} per Mtok (${dimensions} at ${options.basis})`,
	);
	for (const entry of reportData.blocked) {
		lines.push(
			`  blocked  ${entry.modelID}  ${formatDollars(entry.price)}  ${entry.dimension}`,
		);
	}
	// A listing with no ceiling is a survey: show what each model would cost, so
	// the number to pass to `--under` is visible rather than guessed.
	if (options.under === undefined) {
		for (const entry of reportData.priced) {
			lines.push(
				`  ${formatDollars(entry.price).padEnd(8)} ${entry.modelID}  ${entry.dimension}`,
			);
		}
	}
	for (const entry of reportData.cleared) {
		lines.push(`  cleared  ${entry.modelID}`);
	}
	for (const entry of reportData.errors) lines.push(`  error    ${entry}`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function pass(options) {
	const models = await fetchCatalogue();
	const store = await openStore(storePath(options.db));
	try {
		if (!hasSettingsTable(store)) {
			fail(
				"this database has no settings table; run OpenCode once with the balancer installed",
			);
		}

		const provider = options.provider;
		const decided = models.map((model) => {
			const modelID = String(model.id ?? model.modelID ?? "");
			return { modelID, ...decide(model, options) };
		});
		const block = decided.filter(
			(entry) => entry.action === "block" && entry.modelID !== "",
		);
		const blockedPairs = new Set(
			block.map((entry) => pairKey(provider, entry.modelID)),
		);
		const manifest = readManifest(store);

		// Marks this script wrote that the ceiling no longer supports, or whose
		// model has left the catalogue. Marks written by anyone else are simply
		// not in the manifest, so they are never touched.
		const clear = manifest.filter(
			([pairProvider, pairModel]) =>
				pairProvider === provider &&
				!blockedPairs.has(pairKey(provider, pairModel)),
		);

		const result = {
			allowed: decided.filter((entry) => entry.action === "allow").length,
			at: new Date().toISOString(),
			basis: options.basis,
			blocked: block.map((entry) => ({
				dimension: entry.dimension,
				modelID: entry.modelID,
				price: entry.price,
			})),
			ceiling: options.under,
			cleared: clear.map(([, modelID]) => ({ modelID })),
			db: storePath(options.db),
			dimensions: options.dimensions,
			driver: store.driver,
			errors: [],
			priced: decided
				.filter((entry) => typeof entry.price === "number")
				.map((entry) => ({
					dimension: entry.dimension,
					modelID: entry.modelID,
					price: entry.price,
				}))
				.sort((left, right) => left.price - right.price),
			provider,
			skipped: decided.filter((entry) => entry.action === "skip").length,
		};

		if (options.list || options.dryRun) {
			report(result, options);
			return result;
		}

		const until = Date.now() + options.ttlMinutes * 60_000;
		const at = Date.now();
		for (const entry of block) {
			writeSetting(
				store,
				markKey(provider, entry.modelID),
				JSON.stringify({ at, until }),
			);
		}
		for (const [, modelID] of clear) {
			deleteSetting(store, markKey(provider, modelID));
		}
		writeSetting(
			store,
			MANIFEST,
			JSON.stringify(block.map((entry) => [provider, entry.modelID])),
		);

		report(result, options);
		return result;
	} finally {
		store.close();
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	do {
		try {
			await pass(options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fail(`saygm-ceiling: ${message}`);
		}
		if (options.watchSeconds === 0 || stopping) break;
		await new Promise((resolve) =>
			setTimeout(resolve, options.watchSeconds * 1000),
		);
	} while (!stopping);
}

await main();
