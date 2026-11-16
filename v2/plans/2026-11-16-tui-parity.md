# TUI and Command Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Balancer panel in the OpenCode 2 TUI and make `/balancer` cover every panel read and write, so Desktop, terminal and commands share one state and one set of words.

**Architecture:** A new `./tui` part claims the `session.panel` slot and drives the existing `Balancer` RPC. The server's write handlers move into shared functions that the command parser also calls; pure helpers for rows, cursor and formatting are unit-tested, while the JSX is verified by typecheck, lint and a manual parity pass.

**Tech Stack:** TypeScript, Solid JSX, `@opencode/plugin/tui`, OpenTUI, Bun test, Bun SQLite.

**Spec:** `v2/design/tui-panel-parity.md`

## Global Constraints

- V2 only. Do not modify `src/` or the V1 TUI.
- The TUI reads and writes only through `ctx.client.rpc(Balancer)`. It never opens the SQLite store.
- English copy for the TUI and commands comes from `v2/copy.ts`. The GUI keeps `ctx.t(...)` at call sites but its `en` table is that same object.
- Every write — RPC and command — goes through `server/settings.ts` or `server/writes.ts`. No command calls a core mutator directly.
- State words are fixed: `active` = `!disabled && !limited`; `limited` = `rateLimitedUntil != null`; `in use` = served the most recent request; a target's state is its row state word.
- The TUI refreshes the full panel every two seconds and pauses only while a grip is grabbed.
- `default` resets a stored value. A verb carrying two settings validates both before writing either.
- Peers: `@opentui/core` and `@opentui/solid` `>=0.6.6`, `solid-js` `>=1.9.0`.
- `bun` is not on `PATH`: use `npx --yes bun ...` from the repository root.
- If `SQLiteError: disk I/O error` appears, rerun the suite once; it is the known V1 polling leak.
- Commits use `--no-verify`, no vendor or AI trailers, and only the files named by the task.

## Review Focus

- A parked credential whose reason is long or multiline, with a reset time on the clock and an old attempt time: the note must wrap, show `last tried`, and open only one at a time.
- A terminal too narrow for a side panel, or a panel taller than the screen: the host may force full-screen, and the focused control must never sit off-screen.
- An ambiguous or incomplete command (`buffer always`, `rebalance off 90m`, `limit default extra`): it must not write anything and must print usage.
- A two-second poll landing during a grab, or a dialog open when the poll returns: the cursor must not jump and the dialog's value must not be replaced.
- A host with no provider catalogue, or a remote server: `priority`/`chainModels` failures must not blank the panel, and all actions still work over RPC.

---

## File Structure

Create:

- `v2/copy.ts` — the English labels shared by GUI, TUI and commands.
- `v2/core/format.ts` — attempt time, route markers and credential note.
- `v2/server/settings.ts` — setting writes used by RPC and commands.
- `v2/server/writes.ts` — account and chain writes used by RPC and commands.
- `v2/types.ts` — the panel's RPC view types, moved out of `gui.tsx`.
- `v2/tui.tsx` — TUI entry: slot claim, palette command, `open` event.
- `v2/tui/panel.tsx` — the panel component and its local state.
- `v2/tui/rows.ts` — pure derived rows for providers, chains and folds.
- `v2/tui/items.ts` — pure cursor and grab reducer.
- `v2/tests/format.test.ts`
- `v2/tests/settings.test.ts`
- `v2/tests/writes.test.ts`
- `v2/tests/commands-parity.test.ts`
- `v2/tests/tui-rows.test.ts`
- `v2/tests/tui-items.test.ts`

Modify:

- `v2/core/context.ts` — add `cutFor` and `bufferTokens`.
- `v2/gui.tsx` — consume the shared copy, formatting and cut helpers; import view types.
- `v2/server/rpc.ts` — delegate writes and the chain listing to shared functions.
- `v2/server/commands.ts` — new verbs; migrate existing writes; update help and `gui` copy.
- `v2/server/chain-actions.ts` — add `listChainRows`.
- `v2/package.json` — `./tui` export and OpenTUI peers.
- `README.md` — replace the “No TUI” limit; document the terminal panel.
- `v2/design/tui-panel-parity.md` — status line.
- `v2/plans/2026-11-14-model-chains.md` — follow-on entry.

---

### Task 1: Shared copy, formatting and cut helpers

**Files:**
- Create: `v2/copy.ts`, `v2/core/format.ts`, `v2/tests/format.test.ts`
- Modify: `v2/core/context.ts`, `v2/gui.tsx`

**Interfaces:**
- Produces: `copy` (the existing `en` table, moved verbatim), `CopyKey`.
- Produces: `routeMarkers(input: { active: boolean; inUse: boolean; limited: boolean }): RouteMarker[]` where `RouteMarker = "active" | "inUse" | "limited"`; `inUse` wins over `active`, `limited` is additive.
- Produces: `credentialNote(input: { limited: boolean; limitedUntil?: number; reason?: string; now?: number; resets: string }): string | undefined`.
- Produces: `formatAttempt(at?: number): string`.
- Produces in `core/context.ts`: `cutFor(limitText: string, bufferText: string, enforcement: string): number` and `bufferTokens(value: string): number`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { bufferTokens, cutFor } from "../core/context";
import { credentialNote, formatAttempt, routeMarkers } from "../core/format";

describe("route markers", () => {
	test("in use wins over active, and limited stays", () => {
		expect(routeMarkers({ active: true, inUse: true, limited: true })).toEqual([
			"inUse",
			"limited",
		]);
	});
	test("active is the fallback", () => {
		expect(routeMarkers({ active: true, inUse: false, limited: false })).toEqual([
			"active",
		]);
	});
	test("a credential that cannot serve has no route marker", () => {
		expect(routeMarkers({ active: false, inUse: false, limited: false })).toEqual(
			[],
		);
	});
});

describe("credential note", () => {
	const now = new Date(2026, 10, 15, 12, 0).getTime();
	const until = new Date(2026, 10, 15, 14, 21).getTime();

	test("a live credential has no note", () => {
		expect(credentialNote({ limited: false, resets: "resets" })).toBeUndefined();
	});
	test("the refill and the reason join with a dot", () => {
		expect(
			credentialNote({
				limited: true,
				limitedUntil: until,
				now,
				reason: "quota",
				resets: "resets",
			}),
		).toBe("resets 14:21 · quota");
	});
	test("a park with no words has no note", () => {
		expect(credentialNote({ limited: true, resets: "resets" })).toBeUndefined();
	});
});

describe("attempt time", () => {
	test("never tried is a dash", () => {
		expect(formatAttempt(0)).toBe("—");
	});
	test("a real attempt renders", () => {
		expect(formatAttempt(Date.now())).not.toBe("—");
	});
});

describe("cut", () => {
	test("always takes the buffer off", () => {
		expect(cutFor("200", "20", "always")).toBe(180_000);
	});
	test("necessary leaves a limit below the window alone", () => {
		expect(cutFor("200", "20", "necessary")).toBe(200_000);
	});
	test("empty settings use the built-in rule", () => {
		expect(cutFor("", "", "always")).toBe(180_000);
	});
	test("a share has no token size", () => {
		expect(bufferTokens("10%")).toBe(0);
	});
	test("a size reads in tokens", () => {
		expect(bufferTokens("20")).toBe(20_000);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes bun test v2/tests/format.test.ts`
Expected: FAIL with `Cannot find module '../core/format'`.

- [ ] **Step 3: Implement the shared helpers**

Move the `en` table from `gui.tsx` verbatim into `v2/copy.ts` as
`export const copy = { ... } as const;` and `export type CopyKey = keyof typeof copy;`.
Change the GUI's i18n declaration to `en: { ...copy }`.

Implement `v2/core/format.ts` with the three signatures above. Move
`formatAttempt` out of `gui.tsx`; implement `routeMarkers` and `credentialNote`
using `formatRollover` from `core/rollover.ts`.

In `gui.tsx`, replace the inline `inUse`/`active`/`limited` expression with
`routeMarkers(...)` mapped through `ctx.t`, keeping the `limited` marker's
`title` when the provider gave a reason.

Add `cutFor` and `bufferTokens` to `core/context.ts` by moving the GUI's local
`cutFor`/`bufferTokens` bodies there. The GUI's `cutTokens`/`storedCut` call
`cutFor`; delete the local versions.

- [ ] **Step 4: Run the tests and the gate**

Run: `npx --yes bun test v2/tests/format.test.ts`
Expected: PASS.

Run: `npx --yes bun run checktypes && npx --yes bun run build:gui`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add v2/copy.ts v2/core/format.ts v2/core/context.ts v2/gui.tsx v2/tests/format.test.ts
git commit --no-verify -m "Share the panel's copy, note formatting and cut math"
```

---

### Task 2: Shared setting writes

**Files:**
- Create: `v2/server/settings.ts`, `v2/tests/settings.test.ts`
- Modify: `v2/server/rpc.ts`

**Interfaces:**
- Produces: `type WriteResult = { ok: boolean; message: string }`.
- Produces: `writeBalancing(db, enabled)`, `writeContextLimit(db, value)`, `writeContextBuffer(db, value)`, `writeBufferEnforcement(db, value)`, `writeRebalance(db, value)`, `writeRebalanceAuto(db, enabled)`, `writeModelLimit(db, key, value)`, all returning `WriteResult`.
- Consumes: core `context`, `priority`, `rebalance` functions and `recordLog`.

- [ ] **Step 1: Write the failing tests**

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readBuffer, readBufferEnforcement, readLimit, readModelLimit } from "../core/context";
import { getBalancingEnabled } from "../core/priority";
import { getRebalanceAuto, readRebalance } from "../core/rebalance";
import { migrate } from "../core/schema";
import { clearLog, readLog } from "../server/log";
import {
	writeBalancing, writeBufferEnforcement, writeContextBuffer, writeContextLimit,
	writeModelLimit, writeRebalance, writeRebalanceAuto,
} from "../server/settings";

function freshDb() {
	const db = new Database(":memory:");
	migrate(db);
	return db;
}
beforeEach(() => clearLog());

describe("setting writes", () => {
	test("a limit writes, logs and reports", () => {
		const db = freshDb();
		expect(writeContextLimit(db, "200")).toEqual({ ok: true, message: "Context limit is 200k." });
		expect(readLimit(db)).toBe("200");
		expect(readLog().at(-1)).toMatchObject({ kind: "config" });
	});
	test("a bad limit writes nothing", () => {
		const db = freshDb();
		expect(writeContextLimit(db, "soon").ok).toBe(false);
		expect(readLimit(db)).toBeUndefined();
		expect(readLog()).toHaveLength(0);
	});
	test("buffer and enforcement are separate writes", () => {
		const db = freshDb();
		expect(writeContextBuffer(db, "20").ok).toBe(true);
		expect(writeBufferEnforcement(db, "necessary").ok).toBe(true);
		expect(readBuffer(db)).toBe("20");
		expect(readBufferEnforcement(db)).toBe("necessary");
		expect(writeBufferEnforcement(db, "sometimes").ok).toBe(false);
	});
	test("a rebalance length sets the switch, zero shuts it", () => {
		const db = freshDb();
		writeRebalance(db, "90m");
		expect(readRebalance(db)).toBe("90m");
		expect(getRebalanceAuto(db)).toBe(true);
		writeRebalance(db, "0");
		expect(getRebalanceAuto(db)).toBe(false);
		writeRebalanceAuto(db, true);
		expect(readRebalance(db)).toBe("");
	});
	test("a model limit is stored against its row", () => {
		const db = freshDb();
		expect(writeModelLimit(db, "deepseek", "100").ok).toBe(true);
		expect(readModelLimit(db, "deepseek")).toBe("100");
	});
	test("balancing writes and logs", () => {
		const db = freshDb();
		writeBalancing(db, true);
		expect(getBalancingEnabled(db)).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes bun test v2/tests/settings.test.ts`
Expected: FAIL with `Cannot find module '../server/settings'`.

- [ ] **Step 3: Implement `server/settings.ts` and delegate from RPC**

Move the bodies of `setBalancing`, `setContextLimit`, `setContextBuffer`,
`setBufferEnforce`, `setRebalance`, `setRebalanceAuto` and `setModelLimit` out of
`v2/server/rpc.ts` into `v2/server/settings.ts` without changing their messages
or log wording. Move `describeLimit` with them. Each RPC handler becomes a call
to the matching `write...` function.

- [ ] **Step 4: Run the tests and RPC suite**

Run: `npx --yes bun test v2/tests/settings.test.ts v2/tests/rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/server/settings.ts v2/server/rpc.ts v2/tests/settings.test.ts
git commit --no-verify -m "Share setting writes between the panel and commands"
```

---

### Task 3: Shared account writes

**Files:**
- Create: `v2/server/writes.ts`, `v2/tests/writes.test.ts`
- Modify: `v2/server/rpc.ts`

**Interfaces:**
- Produces: `writeSetEnabled(db, input: { providerID: string; alias: string; enabled: boolean }): WriteResult`.
- Produces: `writeSetFreeOnly(db, input: { providerID: string; alias: string; enabled: boolean }): WriteResult`; it also calls `invalidateCatalog()`.
- Produces: `writeUse(db, input: { providerID: string; alias: string }): WriteResult`.
- Produces: `writeMove(db, input: { providerID: string; alias: string; direction?: "up" | "down"; to?: number }): WriteResult`.
- Consumes: `WriteResult` from `server/settings.ts` (export it there).

- [ ] **Step 1: Write the failing tests**

Use a fresh in-memory database, two accounts (`p1/a`, `p1/b`) and `clearLog()`
before each test. Assert:

```ts
test("disable writes the account and a config line", () => {
	const db = freshDb();
	expect(writeSetEnabled(db, { providerID: "p1", alias: "a", enabled: false }).ok).toBe(true);
	expect(getAccount(db, "p1", "a")?.disabled).toBe(true);
	expect(readLog().at(-1)?.text).toBe("p1/a disabled");
});
test("free-only writes the flag and a config line", () => {
	const db = freshDb();
	expect(writeSetFreeOnly(db, { providerID: "p1", alias: "a", enabled: true }).ok).toBe(true);
	expect(getAccount(db, "p1", "a")?.freeOnly).toBe(true);
	expect(readLog().at(-1)?.text).toBe("p1/a free models only");
});
test("use clears a park and records the pick", () => {
	const db = freshDb();
	markRateLimited(db, "p1", "a", 60_000, "resets in 1h");
	expect(writeUse(db, { providerID: "p1", alias: "a" }).ok).toBe(true);
	expect(getAccount(db, "p1", "a")?.rateLimitedUntil).toBeUndefined();
	expect(readLog().at(-1)?.text).toBe("serving with p1/a");
});
test("move changes the order", () => {
	const db = freshDb();
	writeMove(db, { providerID: "p1", alias: "b", direction: "up" });
	expect(orderedAccounts(db).map((a) => a.alias)).toEqual(["b", "a"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes bun test v2/tests/writes.test.ts`
Expected: FAIL with `Cannot find module '../server/writes'`.

- [ ] **Step 3: Implement account writes; delegate from RPC**

Move the handler bodies for `setEnabled`, `setFreeOnly`, `use` and `move` into
`writes.ts`, preserving `forgetRoutingMemory()` and `recordLog(...)` calls. Add
`invalidateCatalog()` to the shared free-only write; the RPC path gains it too.
Replace the RPC handlers with calls to these functions.

- [ ] **Step 4: Run the tests**

Run: `npx --yes bun test v2/tests/writes.test.ts v2/tests/rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/server/writes.ts v2/server/rpc.ts v2/tests/writes.test.ts
git commit --no-verify -m "Share account writes between the panel and commands"
```

---

### Task 4: Shared chain writes

**Files:**
- Modify: `v2/server/writes.ts`, `v2/server/rpc.ts`, `v2/tests/writes.test.ts`

**Interfaces:**
- Produces: `writeChainAdd(ctx, db, input: { key; providerID; modelID }): Promise<WriteResult>`.
- Produces: `writeChainCreate(ctx, db, input: { providerID; modelID }): Promise<{ ok: boolean; message: string; key: string }>`.
- Produces: `writeChainMove(ctx, db, input: { key; providerID; direction?; to? }): Promise<WriteResult>`.
- Produces: `writeChainRemove(ctx, db, input: { key; providerID }): Promise<WriteResult>`.
- Produces: `writeChainReset(ctx, db, key: string): Promise<WriteResult>`.
- Consumes: `rowByKey`, `addTarget`, `createChain`, `shiftTarget`, `shiftTargetTo`, `removeTarget`, `resetRow`, and `forgetRoutingMemory` used by the current RPC handlers.

- [ ] **Step 1: Write the failing tests**

Use a mock `ctx` whose `model.list()` returns the same family with a
`deepseek-v4.1-flash` model on both `p1` and `p2`, and whose `provider.list()`
returns both provider names. Assert:

```ts
test("create, add, move and reset a chain", async () => {
	const db = freshDb();
	const created = await writeChainCreate(ctx, db, {
		providerID: "p1",
		modelID: "deepseek-v4.1-flash",
	});
	expect(created.ok).toBe(true);
	expect(created.key).toBe("deepseek-v4.1-flash");

	expect((await writeChainAdd(ctx, db, {
		key: created.key, providerID: "p2", modelID: "deepseek-v4.1-flash",
	})).ok).toBe(true);

	expect((await writeChainMove(ctx, db, {
		key: created.key, providerID: "p2", direction: "up",
	})).ok).toBe(true);

	expect((await writeChainRemove(ctx, db, {
		key: created.key, providerID: "p2",
	})).ok).toBe(true);

	expect((await writeChainReset(ctx, db, created.key)).ok).toBe(true);
	expect(getStoredChain(db, created.key)).toBeUndefined();
});
test("an unknown row is refused without writing", async () => {
	const db = freshDb();
	expect((await writeChainAdd(ctx, db, {
		key: "missing", providerID: "p1", modelID: "x",
	})).ok).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes bun test v2/tests/writes.test.ts`
Expected: FAIL because `writeChainCreate` is not exported.

- [ ] **Step 3: Implement chain writes; delegate from RPC**

Move the `chainAdd`, `chainCreate`, `chainMove`, `chainRemove` and `chainReset`
handler bodies into `writes.ts`. Keep their messages and
`forgetRoutingMemory()` conditionals. Replace the RPC handlers with calls to
these functions.

- [ ] **Step 4: Run the tests**

Run: `npx --yes bun test v2/tests/writes.test.ts v2/tests/rpc.test.ts v2/tests/chains.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add v2/server/writes.ts v2/server/rpc.ts v2/tests/writes.test.ts
git commit --no-verify -m "Share chain writes between the panel and commands"
```

---

### Task 5: Command read parity

**Files:**
- Modify: `v2/server/commands.ts`, `v2/server/chain-actions.ts`, `v2/server/rpc.ts`
- Create: `v2/tests/commands-parity.test.ts`

**Interfaces:**
- Produces in `chain-actions.ts`: `listChainRows(ctx, db): Promise<Array<{ key; label; package; limit; stored; targets: Array<{ providerID; modelID; resolved; state }> }>>`, used by both the RPC `chains` handler and `/balancer chains`. It returns every row; the command filters.
- Consumes: `copy`, `routeMarkers`, `credentialNote`, `formatAttempt`, `cutFor`, `readLimitedReason`, `readLimitedUntil`, `storePath`, `readLog`, `clearLog`.

- [ ] **Step 1: Write the failing tests**

Use the same `freshDb`, `apiAuth`, `workingCtx` and `beforeEach(clearLog)`
fixtures as `v2/tests/rpc.test.ts` and `v2/tests/balancer.test.ts`.

```ts
test("errors shows the park, its refill and the last attempt", async () => {
	const db = freshDb();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	markAccountUsed(db, "p1", "a");
	markRateLimited(db, "p1", "a", 60_000, "resets in 12d 23h");
	const out = await runCommand({ ctx: {} as never, db, raw: "errors" });
	expect(out).toContain("p1/a");
	expect(out).toContain("limited");
	expect(out).toContain("resets");
	expect(out).toContain("last tried");
});
test("status counts any park, not only unexpired ones", async () => {
	const db = freshDb();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	markRateLimited(db, "p1", "a", -5_000, "old");
	expect(await runCommand({ ctx: {} as never, db, raw: "status" })).toContain(
		"Currently rate limited: 1",
	);
});
test("settings reports the stored values and cut", async () => {
	const db = freshDb();
	writeContextLimit(db, "200");
	writeContextBuffer(db, "20");
	const out = await runCommand({ ctx: {} as never, db, raw: "settings" });
	expect(out).toContain("Context limit: 200");
	expect(out).toContain("Buffer: 20");
	expect(out).toContain("at 180k");
});
test("chains lists a stored row with its count", async () => {
	const db = freshDb();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	saveChain(db, chainFixture());
	const out = await runCommand({ ctx: workingCtx(), db, raw: "chains" });
	expect(out).toContain("deepseek-v4.1-flash");
	expect(out).toContain("custom");
});
test("chain detail shows the model limit and target state", async () => {
	const db = freshDb();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	saveChain(db, chainFixture());
	writeModelLimit(db, "deepseek-v4.1-flash", "100");
	const out = await runCommand({
		ctx: workingCtx(),
		db,
		raw: "chain deepseek-v4.1-flash",
	});
	expect(out).toContain("100");
	expect(out).toContain("available");
});
test("log shows and clears entries", async () => {
	const db = freshDb();
	recordLog("config", "a setting changed");
	expect(await runCommand({ ctx: {} as never, db, raw: "log" })).toContain(
		"a setting changed",
	);
	expect(await runCommand({ ctx: {} as never, db, raw: "log clear" })).toContain(
		"Cleared",
	);
	expect(await runCommand({ ctx: {} as never, db, raw: "log" })).toContain(
		"The log is empty.",
	);
});
test("diag names the store and the counts", async () => {
	const db = freshDb();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	const out = await runCommand({ ctx: workingCtx(), db, raw: "diag" });
	expect(out).toContain("balancer.sqlite");
	expect(out).toContain("1 credential");
});
```

`workingCtx()` returns `{ model: { list: async () => ({ data: [model...] }) } }`
with a `p1` model, as `v2/tests/rpc.test.ts` does. `chainFixture()` is a stored
chain for `deepseek-v4.1-flash` with one `p1` target.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes bun test v2/tests/commands-parity.test.ts`
Expected: FAIL: `errors` returns `Unknown command` or similar.

- [ ] **Step 3: Implement the read verbs**

Add branches in `runCommand`:

- `errors`: for each account with `rateLimitedUntil != null`, print
  `provider/alias  [markers]`, then `  resets <...> · <reason>` when a note
  exists, then `  last tried <time>`.
- `settings`: print the balancing state, `Context limit:` (or `default`),
  `Buffer:` (or `built-in`), `Enforcement:`, `Rebalance after:` and the
  computed `at <cut>` via `cutFor`.
- `chains`: call `listChainRows`, keep rows where `stored` is true or the row
  has more than one target, and print one line per row:
  `key — label — limit or global — custom|automatic — N target(s)`.
- `chain <model>`: add the model's own limit and each target's `resolved` and
  state, matching the detail the panel row shows.
- `log [n]`: `readLog().slice(-n)`; print `HH:MM:SS text`; default 50.
  `log clear` clears and says `Cleared the log.`; empty says `The log is empty.`
- `diag`: `storePath()`, credential/row/log counts, and the settings summary.

Extract the RPC `chains` handler's body into `listChainRows`, keeping every
catalog row and `targetState`; the RPC keeps returning `{ rows }` unchanged.
The command applies the visible-row filter itself.

Update `list`/`status` to the state-word rules: `active` for any can-route
credential, `limited` for any park, no countdown, and a `resets` note.

- [ ] **Step 4: Run the tests**

Run: `npx --yes bun test v2/tests/commands-parity.test.ts v2/tests/balancer.test.ts v2/tests/rpc.test.ts`
Expected: PASS after updating any old `list`/`status` assertions that expected a
countdown or the stored-alias meaning of `active`.

- [ ] **Step 5: Commit**

```bash
git add v2/server/commands.ts v2/server/chain-actions.ts v2/server/rpc.ts v2/tests/commands-parity.test.ts v2/tests/balancer.test.ts
git commit --no-verify -m "Give commands the panel's reads, words and errors"
```

---

### Task 6: Command write parity and migrated verbs

**Files:**
- Modify: `v2/server/commands.ts`, `v2/tests/commands-parity.test.ts`, `v2/tests/balancer.test.ts`

**Interfaces:**
- Consumes: all `write...` functions from Tasks 2–4.
- Produces grammar: `limit <value|default>`, `buffer <value> [always|necessary]`, `buffer <always|necessary>`, `buffer default [always|necessary]`, `rebalance on [length]`, `rebalance off`, `rebalance <length>`, `rebalance default`, `chain <model> limit <value|default>`, `create <provider> <model>`.

- [ ] **Step 1: Write the failing tests**

Add cases asserting both state and the absence of partial writes:

```ts
test("limit sets and default clears", async () => {
	const db = freshDb();
	await runCommand({ ctx: {} as never, db, raw: "limit 200" });
	expect(readLimit(db)).toBe("200");
	await runCommand({ ctx: {} as never, db, raw: "limit default" });
	expect(readLimit(db)).toBeUndefined();
});
test("buffer validates both parts before writing either", async () => {
	const db = freshDb();
	await runCommand({ ctx: {} as never, db, raw: "buffer 20 necessary" });
	expect(readBuffer(db)).toBe("20");
	expect(readBufferEnforcement(db)).toBe("necessary");
	await runCommand({ ctx: {} as never, db, raw: "buffer nonsense always" });
	expect(readBuffer(db)).toBe("20");
	expect(readBufferEnforcement(db)).toBe("necessary");
});
test("rebalance off with a length is refused", async () => {
	const db = freshDb();
	const before = getRebalanceAuto(db);
	const out = await runCommand({ ctx: {} as never, db, raw: "rebalance off 90m" });
	expect(out).toContain("Usage:");
	expect(getRebalanceAuto(db)).toBe(before);
});
test("a model limit sets and clears", async () => {
	const db = freshDb();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	const ctx = workingCtx();
	await runCommand({ ctx, db, raw: "chain deepseek-v4.1-flash limit 100" });
	expect(readModelLimit(db, "deepseek-v4.1-flash")).toBe("100");
	await runCommand({ ctx, db, raw: "chain deepseek-v4.1-flash limit default" });
	expect(readModelLimit(db, "deepseek-v4.1-flash")).toBeUndefined();
});
test("create registers a row", async () => {
	const db = freshDb();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	const out = await runCommand({ ctx: workingCtx(), db, raw: "create p1 deepseek-v4.1-flash" });
	expect(out).toContain("deepseek-v4.1-flash");
	expect(getStoredChain(db, "deepseek-v4.1-flash")).toBeDefined();
});
test("existing verbs now write the config log", async () => {
	const db = freshDb();
	clearLog();
	saveAccount(db, "p1", "a", apiAuth("k1"));
	await runCommand({ ctx: {} as never, db, raw: "enable p1/a" });
	expect(readLog().some((entry) => entry.text === "p1/a enabled")).toBe(true);
	await runCommand({ ctx: {} as never, db, raw: "free p1 on" });
	expect(readLog().some((entry) => entry.text === "p1/a free models only")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes bun test v2/tests/commands-parity.test.ts`
Expected: FAIL on the new verbs.

- [ ] **Step 3: Implement the verbs and migrate existing writes**

- `limit`: `writeContextLimit(db, value === "default" ? "" : value)`.
- `buffer`: parse the two forms; validate the value first, then enforcement;
  write both only after validation.
- `rebalance`: `on`/`off` call `writeRebalanceAuto`; a length calls
  `writeRebalance`; `default` calls `writeRebalance(db, "")`; `off` plus a
  length is usage.
- `chain <model> limit`: `writeModelLimit` with `default` mapped to `""`.
- `create`: `writeChainCreate(ctx, db, { providerID, modelID: args.slice(1).join(" ") })`.
- Replace direct core calls in `on`/`off`, `enable`/`disable`, `free`, `use`,
  `up`/`down`, and the `chain` verbs with the shared writes. Keep command-level
  aggregation sentences where they already summarize several credentials.
- Update the `help` text and change `gui` to say `Open the Balancer panel`.

- [ ] **Step 4: Run the tests**

Run: `npx --yes bun test v2/tests/commands-parity.test.ts v2/tests/balancer.test.ts`
Expected: PASS after updating old message assertions (for example `use` now
prints the shared sentence).

- [ ] **Step 5: Commit**

```bash
git add v2/server/commands.ts v2/tests/commands-parity.test.ts v2/tests/balancer.test.ts
git commit --no-verify -m "Give commands every panel write, through shared setters"
```

---

### Task 7: TUI thin slice

**Files:**
- Create: `v2/tui.tsx`, `v2/tui/panel.tsx`
- Modify: `v2/package.json`

**Interfaces:**
- Consumes: `Balancer` from `v2/rpc.ts`, `Plugin` from `@opencode/plugin/tui`, `Show` from `solid-js`.
- Produces: `BalancerPanel(props: { ctx: Context; panel: PanelInput })`, initially rendering the title, balancing state and message line.
- Produces helpers used by later sections: `run(action: () => Promise<unknown>): Promise<void>` (sets `message` on `ok: false`, refreshes on success), `edit(title, value, apply)` (prompt, cancel does nothing) and `pick(title, options)` (select, cancel returns `undefined`).
- Produces package export `"./tui": "./tui.tsx"` and peers.

- [ ] **Step 1: Add the export and peers**

`v2/package.json` exports gain `"./tui": "./tui.tsx"`. Add:

```json
"peerDependencies": {
  "@opentui/core": ">=0.6.6",
  "@opentui/solid": ">=0.6.6",
  "solid-js": ">=1.9.0"
}
```

Run `node -e 'JSON.parse(require("fs").readFileSync("v2/package.json","utf8"))'`
to prove it parses.

- [ ] **Step 2: Implement the entry**

`v2/tui.tsx`:

- `Plugin.define({ id: "balancer.tui", setup(ctx) { ... } })`.
- Claim `append: "session.panel"`, rendering `<BalancerPanel>` only when
  `panel.name === "balancer.panel"`.
- Register `ctx.keymap.layer` with command id `balancer.open`, title
  `Open Balancer`, `palette: true`, `bind: "ctrl+shift+b"`, running
  `ctx.ui.panel.open("balancer.panel")`; on `false`, toast `Open a session first.`
- Subscribe `ctx.client.rpc(Balancer).events.on("open", open)` and return a
  cleanup that unsubscribes and unregisters the slot.
- No `ctx.signal` exists in the TUI context; cleanup is the returned function.

`v2/tui/panel.tsx` renders a focusable column inside a `scrollbox`, with
`Balancer`, a balancing toggle, the last failure in a message line, and the
panel's shared helpers. On mount, run a `refresh()` that reads status, list,
chains, priority, contextLimit, contextBuffer, rebalance and log in one
`Promise.all`; every two seconds run it again; clear the interval on cleanup. A
failed refresh keeps the last good state. `f` calls `panel.toggleFullscreen`;
`q` calls `panel.close`.

Implement the helpers once, in the panel:

```ts
const run = async (action: () => Promise<unknown>) => {
	try {
		const reply = (await action()) as Reply;
		setMessage(reply.ok ? "" : reply.message);
		await refresh();
	} catch (error) {
		setMessage(error instanceof Error ? error.message : String(error));
	}
};
const edit = async (title: string, value: string, apply: (value: string) => Promise<unknown>) => {
	const next = await ctx.ui.dialog.prompt({ title, value });
	if (next === undefined || next === value) return;
	await run(() => apply(next));
};
const pick = <T extends string>(title: string, options: readonly { title: string; value: T }[]) =>
	ctx.ui.dialog.select<T>({ title, options });
```

Until Task 8 moves the view types into `v2/types.ts`, declare
`type Reply = { ok: boolean; message: string }` locally in `panel.tsx`.

- [ ] **Step 3: Typecheck, lint and build**

Run: `npx --yes bun run checktypes && npx --yes bun run lint && npx --yes bun run build:gui`
Expected: all succeed.

- [ ] **Step 4: Manual check**

Run `opencode` in a terminal on this repository. Confirm the palette entry
**Open Balancer**, `/balancer gui`, and `ctrl+shift+b` each open the panel in the
current session, and that `f`/`q` behave. If no TTY is available, record that
the check is outstanding and ask the human partner to run it.

- [ ] **Step 5: Commit**

```bash
git add v2/tui.tsx v2/tui/panel.tsx v2/package.json
git commit --no-verify -m "Load a Balancer panel in the OpenCode 2 TUI"
```

---

### Task 8: Derived rows and shared view types

**Files:**
- Create: `v2/types.ts`, `v2/tui/rows.ts`, `v2/tests/tui-rows.test.ts`
- Modify: `v2/gui.tsx`

**Interfaces:**
- Produces in `v2/types.ts`: `Account`, `Target`, `Chain`, `Provider`, `Status`, `Listed`, `Chains`, `Providers`, `Models`, `ContextState`, `BufferState`, `RebalanceState`, `LogEntry`, `Reply` — moved verbatim from `gui.tsx`.
- Produces: `providerEntries(accounts, providers)`, `visibleChains(chains)`, `groupedChains(chains)`, `allCollapsed(input)`, `rowNote(account, resets, now?)`.
- `allCollapsed({ collapsed, chains, groups, modelsOpen })` returns `false` when `modelsOpen` is true, otherwise every visible chain is folded.

- [ ] **Step 1: Move the view types**

Cut the type declarations from `v2/gui.tsx` into `v2/types.ts` and import them
back. Move the TUI's local `Reply` and any duplicated view types to the same
module. Run `npx --yes bun run checktypes`; expected: PASS.

- [ ] **Step 2: Write the failing row tests**

```ts
test("providers are listed in order with their account", () => {
	const entries = providerEntries([account("p1", "a"), account("p2", "a")], [provider("p1"), provider("p2")]);
	expect(entries.map((row) => row.entry.providerID)).toEqual(["p1", "p2"]);
	expect(entries[0].account?.alias).toBe("a");
});
test("only stored or multi-target rows are visible", () => {
	expect(visibleChains([chain("one", false, 1), chain("two", false, 2), chain("three", true, 1)]).map((row) => row.key)).toEqual(["three", "two"]);
});
test("allCollapsed includes the models section", () => {
	const rows = [chain("a", true, 1)];
	expect(allCollapsed({ chains: rows, collapsed: {}, groups: {}, modelsOpen: true })).toBe(false);
	expect(allCollapsed({ chains: rows, collapsed: {}, groups: {}, modelsOpen: false })).toBe(true);
	expect(allCollapsed({ chains: rows, collapsed: { a: false }, groups: {}, modelsOpen: false })).toBe(false);
});
test("rowNote uses the shared note", () => {
	const note = rowNote({ ...account("p1", "a"), limited: true, limitedUntil: 0, limitedReason: "quota" }, "resets");
	expect(note).toBe("quota");
});
```

- [ ] **Step 3: Implement `rows.ts` and run the tests**

Use `groupByBrand` from `core/models.ts` and `credentialNote` from
`core/format.ts`. Run: `npx --yes bun test v2/tests/tui-rows.test.ts`.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add v2/types.ts v2/tui/rows.ts v2/gui.tsx v2/tests/tui-rows.test.ts
git commit --no-verify -m "Derive the TUI's rows from the panel's data"
```

---

### Task 9: Cursor reducer and panel keymap

**Files:**
- Create: `v2/tui/items.ts`, `v2/tests/tui-items.test.ts`
- Modify: `v2/tui/panel.tsx`

**Interfaces:**
- Produces: `type Grab = { kind: "provider" } | { kind: "target"; key: string }`.
- Produces: `type Cursor = { index: number; grab?: Grab }`.
- Produces: `clampCursor(index, count)`, `moveCursor(index, delta, count)`, `pageCursor(index, deltaPages, count, pageSize)`, `beginGrab(index, grab)`, `endGrab(cursor)`, `grabMove(cursor, delta, count): number | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
test("the cursor clamps to the item list", () => {
	expect(moveCursor(0, -1, 3)).toBe(0);
	expect(moveCursor(2, 1, 3)).toBe(2);
	expect(moveCursor(1, 1, 3)).toBe(2);
});
test("a page moves by the page size and clamps", () => {
	expect(pageCursor(1, 1, 20, 5)).toBe(6);
	expect(pageCursor(18, 1, 20, 5)).toBe(19);
	expect(pageCursor(2, -1, 20, 5)).toBe(0);
});
test("a grab moves one slot and refuses the ends", () => {
	const cursor = beginGrab(1, { kind: "provider" });
	expect(grabMove(cursor, -1, 3)).toBe(0);
	expect(grabMove(cursor, 1, 3)).toBe(2);
	expect(grabMove({ index: 0, grab: { kind: "provider" } }, -1, 3)).toBeUndefined();
	expect(endGrab(cursor).grab).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes bun test v2/tests/tui-items.test.ts`
Expected: FAIL with `Cannot find module '../tui/items'`.

- [ ] **Step 3: Implement the reducer and run the test**

Implement the signatures above with plain clamping. Run the test; expected:
PASS.

- [ ] **Step 4: Wire the panel keymap**

Give the panel a focusable container and one ordered list of focus items, one
per rendered control. Map:

- `Up`/`Down`, `j`/`k`: `moveCursor` by one.
- `PgUp`/`PgDn`: `pageCursor` by `Math.max(1, ctx.renderer.height - 6)` items.
- `Home`/`End`: first and last item.
- `Tab`/`Shift+Tab`: next and previous item.
- `Enter`/`Space`: run the focused item's activate callback.
- On a grip item, `Enter` starts a grab; `Up`/`Down` call `grabMove` and the
  matching RPC; `Enter`/`Esc`/`Left`/`Right` release. Other keys leave the grab
  alone.
- `r` refreshes, `f` toggles full-screen, `q` closes, `Esc` releases a grab.

Focus the container on mount. The item list is rebuilt each render from the
current sections; the cursor is clamped when its length changes. Keep the
focused item visible: use the scrollbox's scroll-into-view when available,
otherwise window the list by the renderer height.

- [ ] **Step 5: Commit**

```bash
git add v2/tui/items.ts v2/tui/panel.tsx v2/tests/tui-items.test.ts
git commit --no-verify -m "Add the TUI's cursor, keymap and grab handling"
```

---

### Task 10: Header settings and providers section

**Files:**
- Modify: `v2/tui/panel.tsx`

**Interfaces:**
- Consumes: `providerEntries`, `routeMarkers`, `credentialNote`, `formatAttempt`, `copy`, `cutFor`, `bufferTokens`, `run`, `edit`, `pick`, `Cursor`.
- Produces: the rebalance, limit, buffer and enforce controls; the provider rows, note disclosure, `free`/`use`, and grip reordering.

- [ ] **Step 1: Render the header settings**

Below the title and balancing toggle, render the controls in Desktop order:

- `rebalance after` toggle and the stored length from `rpc.rebalance()`
  (`auto` and `value`; empty means the built-in duration).
- `context limit` as stored from `rpc.contextLimit()`, plus `at <cut>` from
  `cutFor(limit, buffer, enforcement)`.
- `buffer` as stored from `rpc.contextBuffer()`, its token readout when the
  value is a size, and the `enforce` value.

Add one focus item per control after the balancing toggle.

- [ ] **Step 2: Wire the header actions**

- Rebalance toggle: `run(() => rpc.setRebalanceAuto({ enabled: next }))`.
- Rebalance length: `edit("rebalance after", value, (next) =>
  rpc.setRebalance({ value: next }))`; empty or `0` follows the RPC's own rule.
- Context limit: `edit("context limit", value, (next) =>
  rpc.setContextLimit({ value: next }))`; empty restores the default.
- Buffer: `edit("buffer", value, (next) => rpc.setContextBuffer({ value: next }))`.
- Enforce: `pick("enforce", [{ title: copy.always, value: "always" }, { title:
  copy.necessary, value: "necessary" }])`, then
  `rpc.setBufferEnforce({ value })`.

- [ ] **Step 3: Render the provider section**

Add a `Providers` component after the header. Render one two-line block per
`providerEntries` row: enable toggle, `Provider / alias`, markers from
`routeMarkers` mapped through `copy`, then the control line with the note,
`[x] free`, `[use]` and `⠿`. Wrap long identity and note text; at a narrow
width the control line may sit under the note rather than beside it.

Add these focus items in render order: enable, note (only when a note exists),
free, use, grip.

- [ ] **Step 4: Wire the provider actions**

Enter on the enable/free toggles calls `run` with
`rpc.setEnabled`/`rpc.setFreeOnly`; `use` calls `rpc.use`; the note toggles
`openNote`; the grip starts a grab. While grabbed, `Up`/`Down` call `rpc.move`
one slot and refresh; Enter/Esc release. Mark the grabbed row `moving`.

- [ ] **Step 5: Typecheck and lint**

Run: `npx --yes bun run checktypes && npx --yes bun run lint`
Expected: both succeed.

- [ ] **Step 6: Manual check**

Open the panel in a terminal. Confirm the two-line shape, marker words, note
expansion with `last tried`, free/use, both reorder directions, and each header
control. Change a credential or setting in Desktop and see the TUI update
within two seconds.

- [ ] **Step 7: Commit**

```bash
git add v2/tui/panel.tsx
git commit --no-verify -m "Render the TUI's header settings and provider rows"
```

---

### Task 11: Models section

**Files:**
- Modify: `v2/tui/panel.tsx`

**Interfaces:**
- Consumes: `visibleChains`, `groupedChains`, `allCollapsed`, `copy`, `run`, `pick`, `edit`.
- Produces: section fold, brand groups, chain rows, targets, add-target, new-chain, model limit and reset.

- [ ] **Step 1: Render the section and folds**

Add a `Models` component after providers. Header items: section fold,
`+ new chain`/`cancel`, `expand all`/`collapse all`. Groups appear only when a
brand has more than one row; rows start folded. A row shows its label,
`custom|automatic`, its limit and targets. A target shows index, provider,
model, `→ resolved` and its state when not `available`. Wrap long labels and
targets rather than truncating the control.

Add a focus item for every fold, row, limit, reset, target, grip, remove and
add-target control, and for the new-chain/cancel button.

- [ ] **Step 2: Wire the actions**

- New chain: provider select, then model select from `rpc.chainModels`, then
  `rpc.chainCreate`; cancel clears the draft. Opening it opens the section.
- Add target: provider select excluding used providers, then model select, then
  `rpc.chainAdd`; if none are addable, show the same note Desktop shows.
- Limit: `ctx.ui.dialog.prompt` prefilled with `chain.limit`; empty follows the
  global. Reset calls `rpc.chainReset`; remove calls `rpc.chainRemove`; target
  grip uses `rpc.chainMove`.
- Fold all sets every row and group and the section itself; collapsing the
  section clears a draft.

- [ ] **Step 3: Typecheck and lint**

Run: `npx --yes bun run checktypes && npx --yes bun run lint`
Expected: both succeed.

- [ ] **Step 4: Manual check**

Confirm a new chain, cancel, add/remove target, target reorder, model limit,
reset, brand fold, section fold and `expand all`/`collapse all`. Compare the
same row in Desktop.

- [ ] **Step 5: Commit**

```bash
git add v2/tui/panel.tsx
git commit --no-verify -m "Render and operate the TUI's chain editor"
```

---

### Task 12: Diagnostics, log and live refresh

**Files:**
- Modify: `v2/tui/panel.tsx`

**Interfaces:**
- Consumes: `rpc.log`, `rpc.clearLog`, `readLog`-shaped entries, `lastRefreshed`, `message`.
- Produces: the diagnostics fold, log, clear, refresh and the full two-second poll.

- [ ] **Step 1: Add the diagnostics section**

After models, add `diagnostics` with the log-line count and `refresh`. Open:
app version from `ctx.app.version`, `values <time>`, credential/row/log counts,
stored limit and cut, `clear` when the log is non-empty, and the log entries,
newest last, route lines undimmed and other lines dimmed. Use `copy.logEmpty`
when empty. Add focus items for the diagnostics fold, the refresh control and
`clear`.

- [ ] **Step 2: Complete the live loop**

The full `refresh()` exists from Task 7. Keep the two-second interval and add
the grab guard: skip a tick while a grip is grabbed, then refresh after release.
Wrap every mutation in `run`: on `ok: false` set `message`, on success clear it
and refresh. `r` refreshes; `clear` calls `rpc.clearLog`. Dialogs hold their own
value, so a refresh must not touch an open dialog.

- [ ] **Step 3: Typecheck, lint and build**

Run: `npx --yes bun run checktypes && npx --yes bun run lint && npx --yes bun run build:gui`
Expected: all succeed.

- [ ] **Step 4: Manual check**

Change balancing, a switch and a model limit in Desktop; confirm each appears
in the TUI within two seconds without a dialog being overwritten. Clear the log
from the TUI and see the Desktop log empty on its next refresh.

- [ ] **Step 5: Commit**

```bash
git add v2/tui/panel.tsx
git commit --no-verify -m "Add diagnostics and full live refresh to the TUI panel"
```

---

### Task 13: Final gate, parity pass and docs

**Files:**
- Modify: `README.md`, `v2/design/tui-panel-parity.md`, `v2/plans/2026-11-14-model-chains.md`

- [x] **Step 1: Update the docs**

- `README.md`: replace the “No TUI” deliberate limit with a terminal-panel
  paragraph: the `./tui` part, the palette entry, `ctrl+shift+b`, and
  `/balancer gui`. The “Desktop GUI” heading becomes “Desktop and terminal
  panels”.
- `v2/design/tui-panel-parity.md`: status becomes `implemented`.
- `v2/plans/2026-11-14-model-chains.md`: add a follow-on entry naming the TUI
  panel, command parity and the shared setters.

- [x] **Step 2: Run the full gate**

```bash
npx --yes bun run lint
npx --yes bun run checktypes
npx --yes bun test
npx --yes bun run build:gui
```

Expected: lint and types clean; tests pass (if the SQLite I/O flake appears,
rerun once); GUI build succeeds.

- [ ] **Step 3: Walk the parity matrix — OUTSTANDING (no interactive TTY in this session)**

With Desktop and a terminal on the same session, walk
`v2/design/tui-panel-parity.md` top to bottom. For each row, perform the
Desktop action, the TUI action and the command; confirm the same state and the
same words. Exercise a parked credential with a long error, a new chain, target
add/remove/reorder, model limit, clear log, and a 60-column terminal.

- [x] **Step 4: Commit and push**

```bash
git add README.md v2/design/tui-panel-parity.md v2/plans/2026-11-14-model-chains.md
git commit --no-verify -m "Document TUI and command parity"
git push origin main
```

- [ ] **Step 5: Verify CI — recorded in the session ledger after the push**

Wait for the `test` and `Release` workflows on the pushed commit; both must be
green. No changeset is created by this task; do not cut a release without the
human partner asking.
