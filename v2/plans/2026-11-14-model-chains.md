# Model chains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `Balancer · …` row route to an ordered list of provider+model targets, editable from the panel, sized to the smallest context window in that list.

**Architecture:** A stored chain (two new SQLite tables) replaces the automatic family routes for a row once edited. `loadCatalog` continues to build automatic families and appends stored-only rows, attaching the effective target list and the smallest limits. Routing walks the resolved targets, skipping disabled providers, unavailable models, and unhealthy accounts. The declared context is the smallest real context divided by `1 − buffer`, read from the user's compaction config.

---

## Status — reconciled 2026-11-15

The chain work in this plan **shipped**. Read this section first; it supersedes the
task text below where the two disagree, and two tasks were overtaken by later
decisions rather than completed as written.

| Task | State |
|---|---|
| 1 — chain store and migration | shipped |
| 2 — buffer reading and window compensation | **superseded** |
| 3 — resolve rows and register stored chains | shipped, except the window rule |
| 4 — route through the resolved chain | shipped, except the overflow guard |
| 5 — commands | shipped |
| 6 — RPC | shipped |
| 7 — panel editor | shipped |
| 8 — docs and end-to-end check | shipped |

**Task 8 Step 3, the live check, has since been run.** The credential walk was observed
routing a real request: the log line `deepseek-v4.1-flash: cline-pass/clinepass (first
choice)` while `opencode/personal` was parked. The live RPC agrees — a row resolves each
credential in order and reports the parked one `unavailable`, the next `next`, the rest
`available`, and a free-only row resolves its parked credential to the free variant
(`opencode → deepseek-v4.1-flash-free`). So "routing works" no longer rests on unit tests
alone; the Outstanding note that said otherwise is gone.

**What was superseded, and by what.** Commit `1813a2f` ("Report a 1M window for every
balancer model and compact it ourselves") removed the whole buffer mechanism:

- Task 2 and `v2/core/limits.ts`, `v2/server/compaction-config.ts` and their tests are
  **deleted**. Nothing reads `compaction.buffer` from `opencode.json` any more, and the
  `"buffer"` key still sitting in a user's config is inert. The `declaredContext` /
  `rowWindow` formulas in this plan are dead: the declared window is a flat
  `DECLARED_CONTEXT` (1M) and the threshold is the shares in `v2/core/context.ts`.
- Task 4 Steps 5–8 (the overflow guard, `estimateTokens`, `guardOverflow`) are **gone**.
  Routing no longer looks at the conversation's size at all; the balancer compacts the
  conversation itself, so a request is never held back for being too large for a hop.
- Task 3 Step 3 builds a `ModelFamily.window`; that field no longer exists. The row
  declares `DECLARED_CONTEXT` and keeps only the real `output`, the smallest a hop can
  answer.
- Task 8 Step 1's "window 200k · declares 800k" line is gone with it: the panel now shows
  a `context limit` field (a size in thousands or a share of the declared 1M, with the cut it
  works out to).

**What changed after this plan, and is not described below.** The unit of routing became
the **credential**, not the provider (commits `ff0a5f8`, `f5481b5`):

- One panel row per credential, each with its own `enabled`, `free` and `↑ ↓`. `free` and
  the on/off switch are `accounts.free_only` / `accounts.disabled`; the order is
  `accounts.position`, a global order spanning providers. `provider_priority` is emptied
  by `migrateProviderSettings` and no longer consulted.
- An **automatic** row now walks the credential order itself — the list the panel shows —
  so `↑ ↓` means what it looks like. A **stored** chain is still an explicit order of
  providers and is walked as written, each provider's credentials tried in turn.
- `exclude` and the session's tried-set hold `provider/alias` keys, so parking one
  credential hands over to the provider's next one instead of writing off the provider.
  Before this, Task 4's walk skipped a disabled provider outright, which meant a provider
  with two credentials surfaced the error to the session instead of trying the second.
- Free-only substitution moved from catalogue-load time to routing time: a route keeps the
  model it names and carries its provider's free spelling beside it, so a credential told
  to spend nothing gets that spelling *and* its real window.

**Follow-ons after this reconcile.** Eight changes landed afterwards, on 2026-11-15:

- A row's compaction share is the **model's**, not the target's: `model_percent:<row>` replaces
  `context_percent:<row>:<provider>`, `migrateModelPercent` folds anything the old scheme left onto the
  model once, and the panel's `%` field moved off each target line onto the model's own row (`997c6a2`).
- The reserve kept free below a model's window is settable again (`context_buffer`), as a size in
  thousands or as a share, in the field next to `context limit`
  (`997c6a2`). This is **not** Task 2's `compaction.buffer`: nothing is read from or written to
  `opencode.json`, and Task 2 stays superseded as described above.
- A failover trail older than a five-hour quota window is dropped, so a session that has been idle
  that long starts its balance from the head of the order again rather than resuming where it left off
  (`a45a54e`).
- The `context limit` field takes the same size-or-share grammar as the buffer, so `200` means two
  hundred thousand tokens and `20%` still means a fifth of a window; the `%` suffix the field used to
  print is gone. The stored keys moved to `context_limit` / `model_limit:<row>` to match, and the
  migration puts a `%` back on any bare number an earlier version left, which would otherwise now read
  as thousands of tokens.
- **The buffer is subtracted from the limit, not used as a ceiling below the window.** It was a slice of
  the model's window that lowered the window; it is now a slice of the *limit* — or a size — taken off
  the cut, so the live `25%` limit with a `5%` buffer cuts at 237.5k on any model that can hold 250k,
  and the same limit on a 200k model cuts at 187.5k. A new `enforce` choice
  (`context_buffer_enforce`, `always` or `when necessary`) says whether the reserve comes off every cut
  or only where the limit has reached what the model holds; it defaults to `always`, which is what the
  rule was before the choice existed, and a reserve is kept regardless at or past the model's window.
  The panel's limit field now shows the **cut** it works out to rather than the raw limit, which is the
  number that prompted all of this.
- The panel says **`in use`** where it said `next`: the target that would serve the next request is the
  model currently selected for the row, so one word does where two did. The per-model limit field gained
  the label `limit`, which is what lets the bare `global` placeholder stand and the
  `compacts at the global share, or this model's own` legend under every row's targets go.
- **The idle window is adjustable, and a change to the order starts every session over.** The five-hour
  trail window is now `rebalance_after` (`core/rebalance.ts`), set from the panel line under the title:
  `rebalance after` is a toggle for whether idleness drops a trail at all (`rebalance_auto`), and the
  field beside it is the length — a number and a unit (`90m`, `5h`, `1d 2h`), with an empty field
  keeping the built-in five hours. The two controls are kept in agreement: typing `0`/`never`/`off` is
  the switch going off (and the length is kept, so switching back on restores it), any length typed
  turns it back on, and switching on over a stored zero clears it so the switch cannot sit on with the
  window still shut. A bare number is refused because the neighbouring fields read one as thousands of
  tokens. Every routing change — `use`, `move`, `setEnabled`, `setFreeOnly`, all four chain edits, and
  turning balancing back on — now calls `forgetRoutingMemory()`: it drops each session's trail and pin
  (and the balancer slot, not the per-provider ones the compaction watcher reads) so the next request
  re-derives its route from the order as it now stands, and the window restarts from that request. A
  pick also clears that credential's park, so it serves on the very next request; a reorder does not,
  because the park is the provider's own clock. This is what makes "if the user selects 3 it should try
  4 in the next round" true rather than waiting for the old trail to expire.
- **A park can say when the provider said its quota returns.** `core/rollover.ts` reads the instant out
  of the refusal in the shapes the log has carried — `resets in 12d 23h`, `resets at
  2026-11-14T14:21:16.768Z`, and a bare clock time such as `They reset at 11:27 AM.` — and the credential
  row shows it on a subline under the marker (`resets 14:21`, `resets Nov 26 14:21`). It is read in
  `markRateLimited`, from the whole message before the reason is cut to 300 characters, and stored beside
  the reason as `limited_until:<provider>:<alias>`, so the two are cleared together by `markAccountUsed`
  or `clearAccountPark`. Deliberately **evidence, not policy**: the park is still capped at an hour
  (`MAX_PARK_MS`) and the marker still clears on the next attempt, so the subline is worded from the
  provider's side, a refill already in the past or a year out is refused, and a plain 429 whose only
  window was a `Retry-After` header gets no subline rather than inheriting an older failure's date.

**Outstanding**

- **No proactive awareness of a spent credential.** `usage_snapshots` exists in the schema
  (upstream's V1 dashboard kept it there) but v2 never reads it — only the migration
  recreates it and rename/remove rewrite it. The two usage event types in `core/types.ts`
  have no handler. A credential is therefore only discovered to be exhausted when it
  fails: reactive, never predictive.
- **A long limit is parked for an hour at most.** `MAX_PARK_MS` in `server/hooks.ts` caps
  every park at 1 h. A monthly-exhausted credential is retried hourly for the rest of the month,
  and each attempt is what clears its own `limited` marker. The window a provider states in prose
  *is* read now — `core/rollover.ts` turns it into an instant the panel shows as a subline beside
  `limited` — but that reading is evidence on screen only: it does not lengthen the park.
  Honouring a stated reset, or scaling the cap, remains an open design decision — how long to
  trust a park — not a bug to fix silently. If it is ever honoured, the subline already provides
  the number it would need.
- **The two RPC sections disagree about an expired park.** `list` calls a credential
  `limited`, and so not `active`, whenever `rate_limited_until` is set, on the reasoning
  that a park is cleared by the next attempt rather than the clock (`server/rpc.ts:244`);
  `chains` calls the same credential healthy once the timestamp is in the past
  (`server/rpc.ts:85`), because routing itself would use it then (`server/selection.ts:8`).
  The park clears the moment that credential serves again (`core/accounts.ts:38`), so the
  window is transient — but between expiry and next use the panel's two sections can
  disagree, and the `status` count follows `list`. Which reading is right depends on what
  `active` is taken to mean: "the balancer can send here now" says the clock, "this
  credential has not failed since it was last tried" says the marker. Worth settling
  before the marker is trusted for anything else.

- **`compaction.keep.tokens` is a host knob the plugin cannot reach.** The value decides how much
  recent history survives a compaction verbatim rather than folded into the summary; the host's
  `SessionCompaction` service defaults it to 15000 tokens, reads it from config documents
  (`compaction.keep.tokens`, aliased by `compaction.preserve_recent_tokens`) and re-applies it with
  `configure({keep})` whenever config changes (`opencode.config.compaction`). Nothing in the plugin API
  can set it: `experimental.config.update` accepts only `shell`, there is no config-contribution or
  `configure` surface, and compaction is not an RPC. So an adjustable keep is only reachable two ways —
  writing the key into the user's own config file (the file this plugin deliberately does not touch), or
  taking the compaction over entirely through the `session.compaction` hook, where `result` may carry a
  `summary` and `metadata.keepID` marks the boundary the host replays after (the same field the host
  computes from `keep`). The second needs its own summarisation prompt and model call, so it is a
  feature, not a field.

**Tech Stack:** TypeScript, Bun (`bun:sqlite`, `bun:test`), SolidJS GUI bundle via Vite, OpenCode 2 plugin API (`@opencode/plugin`).

**Spec:** `v2/design/model-chains.md`

## Global Constraints

- Bun is not global: every command runs as `npx --yes bun …` from the repo root; tests run `cd v2 && npx --yes bun test`.
- Gates before a commit: `npx --yes bun run lint`, `npx --yes bun run checktypes`, `npx --yes bun test` (in `v2/`), `npx --yes bun run build`, `npx --yes bun run build:gui`.
- Commits use `--no-verify` (the husky hook needs a global bun) after those gates pass manually.
- No agent, vendor, or AI attribution anywhere in code, commits, or docs.
- `docs/` and `dist/` are gitignored; never commit them.
- Row package never mixes wire formats: a target must share the row's `package`.
- One target per provider per chain.
- Declared context formula: percent buffer `p` → `real / (1 − p)`; integer buffer `b` → `real + b`; no buffer → `real`.
- Display labels: `in use`, `active`, `limited`, `disabled`, `unavailable`.

## Review Focus

- Every provider in a chain disabled or accountless: the request must not silently go to `balancer.invalid`, it must surface as a clear failure.
- A stored chain with zero targets (edited to empty, or a partial write): registration and routing must skip it without throwing.
- Buffer config changed while the app runs: the declared limit must be recomputed on reload, and the plugin must not crash on malformed JSONC.
- Provider disabled then re-enabled: targets must come back without the user re-adding them.
- A stored row whose family no longer exists in any catalogue: the picker row must still register and route.

---

### Task 1: Chain store and migration

**Files:**
- Create: `v2/core/chains.ts`
- Modify: `v2/core/schema.ts` (requiredColumns map around line 414, and the `apply` transaction near line 491)
- Test: `v2/tests/chains.test.ts`

**Interfaces:**
- Consumes: `Database` from `bun:sqlite`, `now()` from `../core/time`.
- Produces:
  ```ts
  export type ChainTarget = { providerID: string; modelID: string; baseURL: string };
  export type StoredChain = { familyKey: string; label: string; package: string; targets: ChainTarget[] };
  export function getStoredChain(db: Database, familyKey: string): StoredChain | undefined;
  export function listStoredChains(db: Database): StoredChain[];
  export function saveChain(db: Database, chain: { familyKey: string; label: string; package: string; targets: readonly ChainTarget[] }): void;
  export function deleteChain(db: Database, familyKey: string): boolean;
  export function moveTarget(db: Database, familyKey: string, providerID: string, direction: -1 | 1): boolean;
  ```

- [x] **Step 1: Write the failing tests**

Create `v2/tests/chains.test.ts` following the `freshDb()` pattern in `v2/tests/balancer.test.ts`:

```ts
test("saving a chain replaces its targets atomically", () => { … saveChain twice, expect the second list only … });
test("targets come back in stored order", () => { … expect target providerIDs [b, a] in that order … });
test("moveTarget swaps neighbours and ignores the edges", () => { … });
test("deleteChain removes the row and reports whether it existed", () => { … });
test("a chain with no targets is not returned by listStoredChains", () => { … });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && npx --yes bun test tests/chains.test.ts`
Expected: FAIL — `Cannot find module "../core/chains"`.

- [x] **Step 3: Create the tables in `v2/core/schema.ts`**

Add to `requiredColumns`:

```ts
model_chains: ["family_key", "label", "package", "updated_at"],
model_chain_targets: ["family_key", "position", "provider_id", "model_id", "base_url"],
```

Inside the `apply` transaction, before `recreateAccounts(db)`, add a plain `CREATE TABLE IF NOT EXISTS` for both, matching the spec's SQL exactly. Keep the existing `hasMigration(db, 1) && schemaIsCurrent(db)` guard working by including the new tables in `requiredColumns`.

- [x] **Step 4: Implement `v2/core/chains.ts`**

Reads join both tables and order by `position`. `saveChain` runs in `db.transaction`: delete the key's targets, upsert the `model_chains` row, insert targets with `position = index`. `moveTarget` reads the current order, swaps, and rewrites positions in one transaction.

- [x] **Step 5: Run the tests to verify they pass**

Run: `cd v2 && npx --yes bun test tests/chains.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add v2/core/chains.ts v2/core/schema.ts v2/tests/chains.test.ts
git commit --no-verify -m "Add a stored model chain table"
```

---

### Task 2: Buffer reading and window compensation

**Files:**
- Create: `v2/core/context.ts`
- Create: `v2/server/compaction-config.ts`
- Test: `v2/tests/context.test.ts`
- Test: `v2/tests/compaction-config.test.ts`

**Interfaces:**
- Produces, from `v2/core/context.ts`:
  ```ts
  export type CompactionBuffer =
    | { kind: "percent"; percent: number }
    | { kind: "tokens"; tokens: number }
    | { kind: "none" };
  export function declaredContext(realContext: number, buffer: CompactionBuffer): number;
  export function rowWindow(
    targets: readonly { context?: number; output?: number }[],
    buffer: CompactionBuffer,
  ): { context: number; output: number } | undefined;
  ```
- Produces, from `v2/server/compaction-config.ts`, which imports the type from `../core/context`:
  ```ts
  export function parseBuffer(value: unknown): CompactionBuffer;
  export function readCompactionBuffer(paths?: { env?: Record<string, string | undefined>; cwd?: string }): CompactionBuffer;
  export function invalidateBufferCache(): void;
  ```

- [x] **SUPERSEDED** — **Step 1: Write the failing context tests**

Create `v2/tests/context.test.ts`:

```ts
test("a percent buffer is compensated away", () => {
  expect(declaredContext(200_000, { kind: "percent", percent: 0.75 })).toBe(800_000);
});
test("the smallest target wins", () => {
  expect(rowWindow([{ context: 1_000_000 }, { context: 200_000 }], { kind: "none" })).toEqual({ context: 200_000, output: 0 });
});
test("output is the smallest output limit", () => {
  expect(rowWindow([{ context: 200_000, output: 32_000 }, { context: 1_000_000, output: 384_000 }], { kind: "none" })).toEqual({ context: 200_000, output: 32_000 });
});
test("an integer buffer is added, not divided", () => {
  expect(declaredContext(200_000, { kind: "tokens", tokens: 20_000 })).toBe(220_000);
});
test("targets without limits are ignored", () => {
  expect(rowWindow([{}, { context: 200_000 }], { kind: "none" })).toEqual({ context: 200_000, output: 0 });
  expect(rowWindow([{}], { kind: "none" })).toBeUndefined();
});
```

- [x] **SUPERSEDED** — **Step 2: Run them to verify they fail**

Run: `cd v2 && npx --yes bun test tests/context.test.ts`
Expected: FAIL — module not found.

- [x] **SUPERSEDED** — **Step 3: Implement `v2/core/context.ts`**

`declaredContext` rounds up with `Math.ceil`, and clamps `percent` to below `1` so a `99.9%` buffer cannot divide by almost zero.

- [x] **SUPERSEDED** — **Step 4: Run them to verify they pass**

Run: `cd v2 && npx --yes bun test tests/context.test.ts`
Expected: PASS.

- [x] **SUPERSEDED** — **Step 5: Write the failing config tests**

Create `v2/tests/compaction-config.test.ts`:

```ts
test("percent strings become fractions", () => expect(parseBuffer("75%")).toEqual({ kind: "percent", percent: 0.75 }));
test("decimal percents are preserved", () => expect(parseBuffer("12.5%")).toEqual({ kind: "percent", percent: 0.125 }));
test("integers are absolute token reservations", () => expect(parseBuffer(20000)).toEqual({ kind: "tokens", tokens: 20000 }));
test("nonsense is treated as no buffer", () => { expect(parseBuffer("abc")).toEqual({ kind: "none" }); expect(parseBuffer(undefined)).toEqual({ kind: "none" }); });
test("reads the first existing config and tolerates comments", () => { … temp jsonc with comments, trailing comma and `"buffer": "75%"` … expect percent 0.75 … });
test("an unreadable file means no buffer", () => { … expect { kind: "none" } … });
test("a rewritten file is re-read after its mtime changes", () => { … invalidateBufferCache() between writes … });
```

- [x] **SUPERSEDED** — **Step 6: Run them to verify they fail**

Run: `cd v2 && npx --yes bun test tests/compaction-config.test.ts`
Expected: FAIL — module not found.

- [x] **SUPERSEDED** — **Step 7: Implement `v2/server/compaction-config.ts`**

Candidate paths in order: `env.OPENCODE_CONFIG`, `<cwd>/opencode.json`, `<cwd>/opencode.jsonc`, `$HOME/.config/opencode/opencode.json`, `$HOME/.config/opencode/opencode.jsonc`. Strip `//` and `/* */` comments and trailing commas before `JSON.parse`; read `compaction.buffer`. Cache keyed by resolved path plus `mtimeMs`. A malformed file is `{ kind: "none" }`, never a throw.

- [x] **SUPERSEDED** — **Step 8: Run them to verify they pass**

Run: `cd v2 && npx --yes bun test tests/compaction-config.test.ts`
Expected: PASS.

- [x] **SUPERSEDED** — **Step 9: Commit**

```bash
git add v2/core/context.ts v2/server/compaction-config.ts v2/tests/context.test.ts v2/tests/compaction-config.test.ts
git commit --no-verify -m "Read the compaction buffer and compensate row windows"
```

---

### Task 3: Resolve rows and register stored chains

**Files:**
- Modify: `v2/server/connectors.ts` (the `loadCatalog` family loop, the `ModelFamily` type, `registerBalancerProvider`)
- Test: `v2/tests/connectors.test.ts` (new)

**Interfaces:**
- Consumes: `listStoredChains`, `ChainTarget` (Task 1); `rowWindow`, `declaredContext` (Task 2).
- Produces, on `ModelFamily`:
  ```ts
  stored?: boolean;
  targets: readonly FamilyRoute[];   // effective order: stored chain, else automatic routes
  window?: { context: number; output: number };
  ```
  and `resolveChain(db, family): FamilyRoute[]` exported from `server/connectors.ts`.

- [x] **Step 1: Write the failing tests**

Use a stub `ctx.model.list()` / `ctx.provider.list()` returning two providers with `limit` metadata, mirroring the shapes in `v2/tests/balancer.test.ts`:

```ts
test("a stored chain replaces the automatic route order", () => { … });
test("a stored chain with no catalog family still yields a row", () => { … expect family named by the stored label … });
test("row window is the smallest target context", () => { … });
test("a stored chain with zero targets is ignored", () => { … });
test("stored targets carry their own baseURL", () => { … });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && npx --yes bun test tests/connectors.test.ts`
Expected: FAIL — `resolveChain` not exported.

- [x] **Step 3: Implement resolution**

In `loadCatalog`: keep building automatic groups, then for each stored chain override `targets` (mapping `ChainTarget` → `FamilyRoute` with the row `package`), or synthesize a family when the key is absent. Label/package come from the stored row. Build a `Map<"providerID:modelID", ModelRecord>` from the already-fetched `models.data` to fill each target's `context`/`output` and the synthetic source record. Compute `window` with `rowWindow`.

In `registerBalancerProvider`: declare `limit: { context: declaredContext(window.context, readCompactionBuffer()), output: window.output }` when `window` exists, and `modelFamily(family.key)`-independent `id`/`modelID` stays `family.key`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && npx --yes bun test tests/connectors.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add v2/server/connectors.ts v2/tests/connectors.test.ts
git commit --no-verify -m "Resolve rows from stored chains and size their windows"
```

---

### Task 4: Route through the resolved chain

**Files:**
- Modify: `v2/server/routing.ts` (`chooseRoute`, `hasAlternativeRoute`)
- Modify: `v2/server/hooks.ts` (`familyFor` must find stored-only rows; pass the compaction-auto flag)
- Test: `v2/tests/routing.test.ts` (new)

**Interfaces:**
- Consumes: `resolveChain`, `ModelFamily` (Task 3); `isProviderEnabled` (new, in `server/routing.ts`).
- Produces: `chooseRoute(db, family, exclude?)` unchanged in name; it now walks `family.targets` and skips a target when its provider is disabled, its model is missing from the row, or no healthy account exists.

- [x] **Step 1: Write the failing tests**

```ts
test("the second target serves when the first provider is limited", () => { … });
test("a disabled provider is skipped in a stored chain", () => { … });
test("a disabled provider is skipped in an automatic chain", () => { … });
test("an unavailable target does not break the row", () => { … });
test("excluded providers are not retried", () => { … });
test("a disabled provider is skipped and comes back when re-enabled", () => { … });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && npx --yes bun test tests/routing.test.ts`
Expected: FAIL — disabled providers still returned.

- [x] **Step 3: Implement the walk**

`isProviderEnabled(db, providerID)` reads the `provider_priority` row (`enabled !== 0` when present, otherwise true); implement it in `server/routing.ts` via `listProviderPriority(db)` to avoid a second query shape. `chooseRoute` walks `family.targets` instead of `sortRoutes(family.routes)`, skipping disabled providers, missing models, and providers without a healthy account. In `hooks.ts`, `familyFor` resolves from `loadCatalog` (which now includes stored rows), so it must not early-return when `family.routes` is empty but `family.targets` is not.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && npx --yes bun test tests/routing.test.ts`
Expected: PASS.

- [x] **SUPERSEDED** — **Step 5: Write the failing overflow guard test**

When `compaction.auto` is false nothing stops a conversation outgrowing a target, so routing must skip a target below the request's estimated size. Add to `v2/tests/routing.test.ts`:

```ts
test("with auto compaction off, a target smaller than the conversation is skipped", () => {
  // build a request body whose JSON length / 4 exceeds the first target's context
  // expect chooseRouteForRequest to return the larger second target
});
test("the same request ignores the guard when auto compaction is on", () => { … });
```

- [x] **SUPERSEDED** — **Step 6: Implement the guard**

Add to `v2/server/routing.ts`:

```ts
export function estimateTokens(body: string): number;   // Math.ceil(body.length / 4)
export function chooseRouteForRequest(
  db: Database,
  family: ModelFamily,
  body: string | undefined,
  options: { guardOverflow: boolean; exclude?: ReadonlySet<string> },
): ChosenRoute | undefined;
```

`hook.ts`'s `http.request` routed branch calls it with `guardOverflow = !getCompactionAutoEnabled()`. Add `getCompactionAutoEnabled()` to `server/compaction-config.ts` reading `compaction.auto`, defaulting to `true`.

- [x] **SUPERSEDED** — **Step 7: Run the tests to verify they pass**

Run: `cd v2 && npx --yes bun test tests/routing.test.ts`
Expected: PASS.

- [x] **SUPERSEDED** — **Step 8: Commit**

```bash
git add v2/server/routing.ts v2/server/hooks.ts v2/tests/routing.test.ts
git commit --no-verify -m "Route through resolved chain targets"
```

---

### Task 5: Commands

**Files:**
- Modify: `v2/server/commands.ts`
- Test: `v2/tests/balancer.test.ts` (extend)

**Interfaces:**
- Consumes: chain store (Task 1), `loadCatalog` (Task 3).
- Produces: `/balancer chain <model> [add|remove|up|down|reset] …`; the `model` and `equivalents` branches are deleted.

- [x] **Step 1: Write the failing tests**

```ts
test("chain lists targets in order with markers", () => { … });
test("chain add appends and refuses a duplicate provider", () => { … });
test("chain remove drops one target and refuses the last", () => { … });
test("chain up moves a target and snapshots the automatic chain", () => { … });
test("chain reset deletes the stored chain", () => { … });
test("the model and equivalents commands are gone", () => { … expect "Unknown command" … });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && npx --yes bun test tests/balancer.test.ts`
Expected: FAIL — `Unknown command: chain`.

- [x] **Step 3: Implement**

`chain` resolves the row through `loadCatalog` (by key or label, via `matchModel`) and implements the subcommands over `v2/core/chains.ts`. `add` validates: provider has an account, model exists in that provider's routable models, package matches, provider not already present. Update the help text: replace the `model`/`equivalents` lines with the `chain` lines.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && npx --yes bun test tests/balancer.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add v2/server/commands.ts v2/tests/balancer.test.ts
git commit --no-verify -m "Edit model chains from the command surface"
```

---

### Task 6: RPC

**Files:**
- Modify: `v2/rpc.ts`, `v2/server/rpc.ts`
- Test: `v2/tests/rpc.test.ts` (new)

**Interfaces:**
- Produces:
  - `chains` → `{ rows: [{ key, label, package, stored, context, declaredContext, targets: [{ providerID, modelID, state }] }] }`
  - `chainAdd` `{ key, providerID, modelID }`, `chainRemove` `{ key, providerID }`, `chainMove` `{ key, providerID, direction }`, `chainReset` `{ key }` — all → `result`
  - `chainModels` `{ providerID }` → `{ models: [{ modelID, name }] }`
  - `priority` entries gain `name: string` and `enabled: boolean`
  - `setModel` removed

- [x] **Step 1: Write the failing tests**

```ts
test("chains reports stored order and the declared window", () => { … });
test("chainAdd rejects a foreign package", () => { … expect ok false … });
test("chainMove rejects an unknown row", () => { … });
test("priority carries provider names", () => { … });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd v2 && npx --yes bun test tests/rpc.test.ts`
Expected: FAIL — unknown method.

- [x] **Step 3: Implement contract and handlers**

Add the schemas in `v2/rpc.ts`, handlers in `v2/server/rpc.ts`; every mutation calls `invalidateCatalog()` and `invalidateBufferCache()` where the buffer is read.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd v2 && npx --yes bun test tests/rpc.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add v2/rpc.ts v2/server/rpc.ts v2/tests/rpc.test.ts
git commit --no-verify -m "Expose chain editing over RPC"
```

---

### Task 7: Panel editor

**Files:**
- Modify: `v2/gui.tsx`
- Modify: `v2/README.md` (chain usage)

**Interfaces:**
- Consumes: `chains`, `chainAdd`, `chainRemove`, `chainMove`, `chainReset`, `chainModels`, `priority` (Task 6).

- [x] **Step 1: Implement the models section**

Below the account rows, `<For each={rows()}>` renders a label line, one line per target with `↑ ↓ ×`, the `window 200k · declares 800k` line, `+ add target`, and `reset`. `+ add target` reveals two `<select>`s populated from `chainModels`, filtered to providers not already in the row.

- [x] **Step 2: Implement the providers section**

A compact list from `priority()` with `↑ ↓` and an enabled checkbox calling the existing `move` and `setEnabled` RPCs.

- [x] **Step 3: Verify it builds and the panel serves the new strings**

Run: `npx --yes bun run build:gui && npx --yes bun run checktypes`
Expected: build writes `v2/dist/gui-experimental.cjs`; then confirm the served code contains `add target` and `window`.

- [x] **Step 4: Commit**

```bash
git add v2/gui.tsx v2/README.md
git commit --no-verify -m "Edit chains and provider order from the panel"
```

---

### Task 8: Docs and end-to-end check

**Files:**
- Modify: `v2/README.md`, `v2/design/model-chains.md` (status line)

- [x] **Step 1: Update README**

Document chains, the window rule with the 200k/800k example, the removed commands, and that the buffer is read from config on reload.

- [x] **Step 2: Full gate**

```bash
npx --yes bun run lint && npx --yes bun run checktypes && (cd v2 && npx --yes bun test) && npx --yes bun run build && npx --yes bun run build:gui
```

Expected: all pass; 40+ tests.

- [ ] **OUTSTANDING** — Step 3: Live check**

Register the row, add a target by hand, confirm the picker still lists it, and confirm a prompt through `balancer/<key>` returns a completion. Record the result in the commit message.

- [x] **Step 4: Commit**

```bash
git add v2/README.md v2/design/model-chains.md
git commit --no-verify -m "Document model chains"
```
