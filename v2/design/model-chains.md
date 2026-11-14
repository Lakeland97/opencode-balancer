# Model chains

Status: implemented. Scope: OpenCode 2 plugin (`v2/`).

> Later change: the order is now the **credential** order, one row per credential, not a
> stored provider priority. Chains still name providers and are still authoritative for a
> row that has one; an automatic row follows the credential order instead. Where this
> document says "provider priority", read "the credential order" — `provider_priority` is
> emptied by `migrateProviderSettings` and no longer consulted.

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
6. Every row declares the same **1M** context window and the balancer compacts the conversation
   itself, so a session that hops between a 200k and a 1M target is trimmed at a point the
   balancer chooses rather than whenever a small target is reached.

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

### Context windows and compaction

A session stays pinned to the virtual row while the hop underneath changes, so the row can only
declare one window. Every row therefore declares the same `limit.context` of **1M**, whatever its
targets really hold. A host that knew the real window would compact on its own at a moment the
balancer cannot choose; declaring one large window hands that decision to the balancer.

The balancer then compacts the conversation itself, from a watcher on `session.step.ended` (whose
token counts are the per-request figure the host shows against the model's limit). Two shares decide
the point, and they measure different windows on purpose:

- the **global share** (`context_percent`) is a slice of the declared 1M, so `20%` always means 200k
  whatever is serving;
- a **per-model share** (`context_percent:<row>:<provider>`) is a slice of that model's own window, so
  `50%` on a 200k model is 100k; it *overrides* the global rather than being capped against it.

The serving model's real window is the hard ceiling under either one, so a global `30%` means 300k on
a 1M model but clamps to 200k when a 200k model is serving. A model whose window is unreported has no
ceiling, so the share stands alone. Nothing is written to `opencode.json`; the shares live in the
plugin's `settings` table.

Because the declaration is 1M, routing never has to hold a request back for being too large for one
of the row's targets — the conversation is trimmed before it can reach that point. A session the
balancer never routed is never compacted, and a compaction already in flight is never doubled.

`limit.output` is the smallest output limit among the targets, since that is the most a hop can be
asked to return; the declaration stays real because output caps one answer, not the conversation.

### Panel

Each account row keeps its markers (`in use`, `active`, `limited`) and buttons. A new **models**
section lists one line per row:

```
DeepSeek V4.1 Flash
  1  commandcode · deepseek/deepseek-v4-flash    [  ]   in use   ↑ ↓ ×
  2  xiaomi-token-plan-sgp · mimo-v2.6-flash     [ 50]  limited  ↑ ↓ ×
  [+ add target]  [reset]
  compacts at the global share, or this model's own
```

The `%` field on a target is that model's own share of its real window; empty follows the global
share set at the top of the panel.

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
| Chain mixes 200k and 1M targets | every row declares 1M; the balancer compacts itself, clamped by whichever target is serving |
| Global share past a target's window | the share is clamped to that model's real window |
| Target window metadata missing | that model still compacts, on the share alone |

## Tests

- `model_chains` / `model_chain_targets` migration applies to an existing database.
- Stored chain order beats provider priority; `reset` restores automatic order.
- `chooseRoute` skips a target with no healthy account and returns the next target's model id.
- A stored row with no catalog family still registers and routes.
- A disabled provider is skipped in automatic and stored chains.
- Retry exclusion by provider prevents a same-provider hop.
- Add refuses a duplicate provider, a foreign package, and an unroutable model.
- Chain snapshot on first move (pure function, tested outside the component).
- Row window declarations: every model claims 1M, and `output` is the smallest target's.
- A conversation is compacted at the lower of the requested share and the serving model's window,
  and never for a session the balancer did not route.

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
