# Model chains

Status: proposed. Scope: OpenCode 2 plugin (`v2/`).

## Intent

Today a `Balancer · …` picker row is one model *family*: the same model offered by several
providers, ordered by provider priority. That answers "which DeepSeek do I use", not "which model
do I use when DeepSeek is unavailable".

The user wants to state a preference across models: *DeepSeek on CommandCode; if that account is
limited, MiMo on Xiaomi Token Plan; if that is gone too, whatever else is available.* They also
want the automatic name matching to be conservative — it may merge spelling variants of one
model, and must never pair unrelated models on its own — and they want a small UI to edit both
the chains and the provider order.

## Goals

1. A picker row resolves to an ordered list of **targets** (provider + that provider's model id),
   not a single family.
2. Automatic linking merges only spelling variants of the same model. Cross-model substitution
   happens only when the user adds it.
3. The user can reorder, remove, add and reset a row's targets, and reorder providers, from the
   Desktop panel.
4. Failover walks the chain; recovery returns to the head of the chain.
5. A chain outlives the model family it was built from: if DeepSeek disappears, the row still
   exists and serves MiMo.
6. A row's context window is sized to the **smallest** target in it, compensated for the user's
   configured compaction buffer, so every target in the chain can take over the same conversation.

## Non-goals

- Translating between wire formats. A target must share the row's package; the plugin rewrites
  URL, credential and body `model`, and cannot reshape a request for another API.
- Automatic tier/price/size substitution between different models.
- Per-account targets. A target names a provider; account selection stays as it is today.
- Two models from the same provider in one chain (unreachable, see below).

## Anti-goals

- A chain silently reordering itself after the user edited it.
- The matcher inventing a link between two models with different names.
- A stale target breaking the whole row instead of being skipped and marked.

## Current state

- `core/models.ts` — `normalizeModel` collapses case, separators, provider prefixes, `:free`;
  `modelFamily` additionally strips a trailing build tag (`-1017`, `-20251001`).
- `server/connectors.ts` — groups connector models by `modelFamily` **and** package, declares one
  virtual model per group, orders routes with `sortRoutes` (provider priority).
- `server/routing.ts` — `chooseRoute` returns the first route with a healthy account;
  `hasAlternativeRoute` drives retry.
- `core/priority.ts` — `provider_priority(provider_id, position, model_id, enabled)`.
- `resolveActiveSelection` / `provider_priority.model_id` are V1 leftovers: nothing in `v2/`
  routes by them.
- GUI: one row per account with `use`/`remove`.

## Design

### Targets and chains

A **target** is `{ providerID, modelID, baseURL, package }`. A **chain** is the ordered target
list for one row key, plus the row's label.

Routing resolves the row to its chain, then filters by "provider enabled and has a healthy
account", preserving chain order.

Two sources:

1. **Automatic** (default): the family routes built today, sorted by provider priority. No new
   storage; behaviour is unchanged.
2. **Stored**: once the row is edited, the stored order is authoritative. Provider-priority
   changes no longer affect that row, which its editor states.

Editing starts from a snapshot of the current automatic chain, so the user reorders what they
already see. A stored chain keeps its own `label` and `package`, so the row survives even when no
connector offers that family any more — that is the whole point of "DeepSeek gone, use MiMo".

### Storage

New table, additive migration:

```sql
CREATE TABLE model_chains (
  family_key  TEXT NOT NULL,
  label       TEXT NOT NULL,
  package     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (family_key)
);

CREATE TABLE model_chain_targets (
  family_key  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  PRIMARY KEY (family_key, provider_id)
);
```

`base_url` is stored per target because a target may no longer exist in any catalog family, and
routing must not depend on a live lookup. One target per provider: account health is provider
level and retry excludes by provider, so a second target on the same provider could never be
reached. The editor refuses it with a message.

Presence of a `model_chains` row makes the chain stored. `reset` deletes both rows.

Targets are validated on write: provider must have a saved account, the model must be in that
provider's routable set, and package must equal the row's package. A stored target whose provider
account, model, or enabled flag later disappears is retained, skipped at routing time, and shown
as `unavailable`; deleting it is the user's call.

### Registration

`registerBalancerProvider` declares one virtual model per **row**, where rows are the union of:

- catalog families (as today), and
- stored chains, including those with no catalog family left.

For a stored chain the label and package come from `model_chains`; a synthetic source record is
used when the family is gone, so the picker row still renders a name and cost metadata from the
head target where available. `reset` on a row with no surviving family deletes the chain and the
row disappears from the picker; the command says so before doing it.

### Routing

`chooseRoute(db, row, exclude)`:

```
targets := storedChain(row.key) ?? automaticChain(row)
for target in targets:
  if target.providerID in exclude: continue
  if !isProviderEnabled(db, target.providerID): continue
  if !modelStillListed(target): continue
  account := selectHealthyAccount(db, target.providerID)
  if !account: continue
  return { ...target, account }
```

- `exclude` stays provider-keyed, matching the retry hook.
- `enabled` becomes meaningful for the first time: a disabled provider is skipped in automatic
  and stored chains alike, and its targets show `unavailable`. This makes the existing
  `/balancer enable|disable` and the new panel toggle real instead of decorative.
- `modelStillListed` checks the provider's current routable set; a withdrawn model is skipped
  without dropping the target.

The virtual model's package is the row's package, and every target shares it, so the request
shape stays valid for every hop.

### Context windows

A session stays pinned to the virtual row while the hop underneath changes, so the row can only
declare one window. Declaring each target's own window would let compaction fire at the wrong
point and let a request overflow the model it lands on.

The row therefore declares the **smallest** `limit.context` among its targets, adjusted for the
user's compaction buffer so that compaction fires at that real limit rather than a fraction of a
lie:

- `compaction.buffer` is a share of the declared window, so a buffer of `p` makes the host
  compact at `context × (1 − p)`.
- To fire at the real minimum `m`, the row declares `m / (1 − p)`. A 200k target under a 75%
  buffer declares 800k and compacts at 200k.
- An integer `buffer` is an absolute reservation, so the row declares `m + buffer`.
- No buffer, or an unreadable config, means the row declares `m` unchanged.

`limit.output` is the smallest output limit among the targets, since that is the most a hop can
be asked to return.

Because the row's trigger sits at `m`, the conversation never exceeds `m` and every target in
the chain — including the 1M ones — accepts it. The cost is that a big target is used up to `m`,
not to its own ceiling; that is the trade the user chose for chains that mix sizes.

Compaction is disabled (`auto: false`): the guard above no longer holds, so routing additionally
skips targets whose `limit.context` is below the conversation's last reported token count. The
row stays usable and the request is never sent somewhere it cannot fit.

`server/compaction-config.ts` reads the effective `compaction.buffer` because the plugin context
exposes no config accessor. Sources, first match wins: `$OPENCODE_CONFIG`, the project's
`opencode.json`/`opencode.jsonc`, then `~/.config/opencode/opencode.json`/`opencode.jsonc`.
JSONC comments and trailing commas are tolerated. The value is cached with its file mtime, and a
buffer change applies after the plugin reloads.

### Panel

Each account row keeps its markers (`in use`, `active`, `limited`) and buttons. A new **models**
section lists one line per row:

```
DeepSeek V4.1 Flash
  1  commandcode · deepseek/deepseek-v4.1-flash     in use   ↑ ↓ ×
  2  xiaomi-token-plan-sgp · mimo-v2.6-flash        limited  ↑ ↓ ×
  [+ add target]  [reset]
  window 200k · declares 800k (75% buffer)
```

The window line states the real minimum and the compensated declaration, so a surprising
compaction point is explained on the row rather than in the host's settings.

- `+ add target` reveals two selects: provider (only providers with accounts, not already in the
  chain, same package) and model (that provider's routable models). Adding appends.
- `↑`/`↓` move a target; the first move snapshots the automatic chain.
- `×` removes a target; removing the last is refused with a message.
- `reset` returns the row to automatic.
- A compact **providers** section reuses the existing `move` RPC, adds `↑`/`↓`, and an `enabled`
  toggle that now actually gates routing.

The panel stays a single scrolling list; no nested modal.

### Commands

```
/balancer chain <model>                       show the ordered targets
/balancer chain <model> add <provider> <model>
/balancer chain <model> remove <provider>
/balancer chain <model> up|down <provider>
/balancer chain <model> reset
/balancer up|down <provider>                  provider priority (exists)
/balancer enable|disable <provider>           now gates routing (exists)
```

`<model>` accepts a row key or the picker's label, including a stored-only row's label.

### Retired surface

`/balancer model`, `/balancer equivalents`, the `setModel` RPC and
`provider_priority.model_id` all describe V1 behaviour that V2 never routed by, and a second
notion of "which model runs" would contradict chains. They are removed; `/balancer model`'s
useful part (accepting a picker label) moves into chain target resolution. The `model_id` column
stays in the schema for upstream compatibility but is no longer written or read.

### RPC

Add `chains`, `chainAdd`, `chainRemove`, `chainMove`, `chainReset`; extend `priority` output with
provider names and `enabled`. Drop `setModel`. All mutations call `invalidateCatalog()`.

### Matching

Unchanged deliberately. `modelFamily` keeps stripping a trailing build tag; a second pass
reports near-miss rows (same first token, different remainder) in `/balancer chain` output as
*possible links*, which the user can add by hand. No automatic pairing.

## Edge cases

| Case | Behaviour |
|---|---|
| Target's provider loses all accounts | skipped, shown `unavailable` |
| Target's model withdraws | skipped, shown `unavailable` |
| Provider disabled | skipped in every chain, shown `unavailable` |
| All targets unavailable | row is unusable; picker keeps it, routing returns none, retry does not loop |
| Family disappears, chain stored | row survives on its stored label and targets |
| Chain edited mid-stream | next request uses the new chain |
| Package mismatch on add | refused with the two package names |
| Second target from one provider | refused: unreachable by design |
| Chain mixes 200k and 1M targets | row declares the 200k minimum, compensated; compaction fires there |
| `compaction.auto` is false | routing skips targets smaller than the conversation's token count |
| Buffer config unreadable | row declares the real minimum; no compensation |
| Target limit metadata missing | that target is ignored for sizing, still routable |

## Tests

- `model_chains` / `model_chain_targets` migration applies to an existing database.
- Stored chain order beats provider priority; `reset` restores automatic order.
- `chooseRoute` skips a target with no healthy account and returns the next target's model id.
- A stored row with no catalog family still registers and routes.
- A disabled provider is skipped in automatic and stored chains.
- Retry exclusion by provider prevents a same-provider hop.
- Add refuses a duplicate provider, a foreign package, and an unroutable model.
- Chain snapshot on first move (pure function, tested outside the component).
- Row window is the smallest target's, and the declaration compensates percent, integer, and
  absent buffers.
- Config reader handles JSONC comments, trailing commas, `$OPENCODE_CONFIG`, and an unreadable
  file.
- A row with mixed 200k/1M targets compacts at 200k: the declaration is 800k under 75%.

## Decisions taken here (mine, not the user's)

- Stored chains are fully explicit rather than auto-plus-overrides, so "what will run" is one
  inspectable list.
- Provider priority stops applying to an edited row, stated in its editor.
- The row keeps its label when its head target changes; the label is the user's handle.
- One target per provider, because a second can never be reached.
- `enabled` gates routing, restoring the meaning of an existing command.
- The dead V1 model-selection surface is removed rather than kept alongside chains.
- Targets are added only from the provider's routable models, so the editor cannot create a
  target that will 404.
