# opencode-balancer

Multiple accounts per provider, automatic failover when one is rate limited, and one picker row
per model family that can be served by any provider you have an account for.

> [!IMPORTANT]
> **This fork is the maintained line.** Upstream
> [`thelioo/opencode-balancer`](https://github.com/thelioo/opencode-balancer) has been dormant
> since July 2026 and still targets the V1 plugin API, which OpenCode 2 refuses to load. Work
> continues here, on OpenCode 2. The V1 plugin at the repository root is kept for OpenCode 1
> users and is no longer developed.

| | |
|---|---|
| OpenCode 2 | supported — this directory |
| OpenCode 1 | the top-level plugin, unchanged, no longer developed |
| Upstream | dormant since 2026-07-17 |

## Why this exists

The published package targets the V1 plugin API (`@opencode-ai/plugin`). OpenCode 2 refuses to
load it:

```
PluginModule.LoadError: Plugin must export a default definition with an id
and an effect or setup function.
```

Upstream `main` still depends on the V1 SDK, and the package's dashboard is a terminal UI, which
OpenCode Desktop does not render. This port keeps the account store and priority logic and
re-implements the integration on the V2 hook surface.

## What was ported

| Part | Status |
|---|---|
| `core/` account store and schema | keeps the upstream store; the credential order it routes by is ours |
| Credential capture | V2 `integration.list` / `connection.resolve`, synced on credential events |
| Credential injection | `session.hook("http.request")` instead of a global `fetch` patch |
| Rate-limit detection | `session.hook("http.response")` |
| Failover | `session.hook("retry")` forces a retry; the next request selects another account or connector |
| Control surface | `/balancer` command + `balancer_command` tool, replacing the terminal dashboard |
| Base URL / provider switching | the `balancer` provider, which routing rewrites per request |

## The Balancer provider

A session's model is readonly in V2, so the plugin cannot switch *providers* on an existing
session. It registers its own provider instead:

1. `balancer` exposes one virtual model per model family — `Balancer · DeepSeek V4.1 Flash` —
   collapsing the per-provider spellings (`deepseek/deepseek-v4.1-flash` and
   `deepseek-v4.1-flash`) into a single picker row.
2. Picking it pins the session to `balancer`, permanently.
3. On `model.request` the plugin chooses the credential in the balancer's order, then rewrites
   the API root, that credential's auth, and the body's `model` field to the connector's own id.
4. `http.response` parks a limited credential; `retry` moves the call to the next like-for-like
   target, so failover crosses providers and steps over credentials without the session noticing.

Families never mix wire formats: a model offered as `anthropic-compatible` gets its own row,
because routing only rewrites the `model` field and the request shape stays whatever the package
built.

## Accounts

Accounts are **not** added by hand. OpenCode is the one place credentials are managed: the balancer
reads every provider and credential OpenCode holds on startup and again whenever a credential is
connected, removed, or switched, and keeps its own copy so a request needs no host call.

That includes **two credentials on the same provider** — connect a personal key and a work key to the
same provider and they become two accounts, each with its own `use`, its own park and reason, and its
own line in the log. The account's name is the credential's own label, so nothing has to be typed.

Deleting a credential in OpenCode removes the account on the next sync; renaming one renames the
account, because the two are matched by the credential's id rather than its text.

**The credential is the unit the balancer routes by.** The panel lists one row per credential, in the
order the router walks them, and every row carries its own three switches:

- `enabled` — a switched-off credential is never chosen, and its row still shows what is parked on it;
- `free` — only models that cost nothing may be sent to it, see below;
- `↑ ↓` — where the row sits in the order, which is the order automatic rows route in.

`use` tells a provider to serve with that credential: the row moves to the top of that provider's
rows, and picking a parked row is the retry it was waiting for, so `use` clears that credential's
cooldown. It is how you test whether a limit has lifted.

## Model chains

Each row is an ordered list of **targets**, one per provider. A row starts in **automatic** order,
which follows the credential order: the first credential whose provider offers the model takes the
request, and lifting a row above another provider's moves it above that provider. Editing the order —
by adding, moving or removing a target — stores the list, and from then on the row routes exactly as
written until you `reset` it.

A target is any model the provider can actually route, so a chain may hold unrelated models. A chain
names **providers**, so the same provider cannot appear twice; each provider's credentials are tried
in the order the panel shows them.

```sh
/balancer chain deepseek-v4.1-flash                        # targets, in the order they are tried
/balancer chain deepseek-v4.1-flash add commandcode deepseek-v4.1-flash
/balancer chain deepseek-v4.1-flash up commandcode
/balancer chain deepseek-v4.1-flash remove commandcode
/balancer chain deepseek-v4.1-flash reset                  # back to the credential order
```

A credential can also be told to use **free models only** — useful when you keep no credits on it. The
balancer then points that credential at its provider's own free spelling of the model the row matched
(`deepseek-v4.1-flash` becomes `deepseek-v4.1-flash-free` where the provider offers one) and skips
that credential when it has none, so the next credential in the order answers instead. A model counts
as free when it is priced at zero or its id carries a `free` marker; unknown pricing is **not** free.

```sh
/balancer free opencode on           # every credential of opencode: free models only
/balancer free opencode/work off     # just the one named `work`
```

The Desktop panel edits the same chains: `↑ ↓ ×` per target, `+ add target` with provider and model
pickers, and a `reset` on any customised row. Each target carries a `%` field for the share of that
model's own window at which it should be compacted; see [Context and compaction](#context-and-compaction).

Routing is **sticky** per session: once a target answers, later requests stay on it while it is
healthy. A failure moves forward to a credential this session has not tried since its last answer,
rather than restarting at the top of the order and parking everything on the way down. When everything
has been tried, the order wraps back to the head. A provider's second credential is a second chance:
parking one is what sends the next request to the other, not an error the session has to see.

`limited` therefore means **failed, and not yet tried again** — it is cleared by the next routing
attempt, or by picking the credential again, not by a clock. Hovering the marker shows what the
endpoint actually reported: the HTTP status, or the host's typed error when it raised one.

A credential row carries one of three markers. `active` means **the balancer can send here**: it is
switched on and not sitting out a park. `in use` means it served the most recent request. `limited`
means it failed and has not been tried since. Two keys on one provider are two rows, so both can read
`active` — the marker is about whether that credential can serve, not about which one is next.

The panel's segments are separated by hairlines, in the order `Balancer`, `context limit`, `providers`,
`models`, `diagnostics`, `log`. `diagnostics` carries the build stamp, when the values on screen were
last read in full, what is loaded, and the `refresh` button — the plumbing, kept off the name line.

A `log` at the bottom records what the balancer actually did during this run: which model went to
which provider and account, every parking with its reason, and each config change. It is folded away
by default, and is refreshed every two seconds together with the `in use` marker, which names the
credential that served the most recent request.

The panel lists only rows that route between providers, or that you built by hand. Rows are grouped
under their brand where a brand has more than one, and every row, group and the whole section can be
folded away; `collapse all` / `expand all` folds the lot at once. The panel opens folded.

The `context limit` field at the top is the share of **1M** — the window every balancer model declares
— at which the balancer compacts a conversation, with the number of tokens that works out to beside
it. It is stored in the plugin's own database, never in `opencode.json`, and nothing needs to reload
for it to take effect: the balancer watches the conversation and asks the host to compact when it
reaches the threshold. A field whose model needs its own share overrides it, see below. Enter a number
from `1` to `99`; an empty field restores the default of `20`.

### Context and compaction

Every balancer model declares `context: 1000000`, whatever the connector behind it really holds. A host
that knew the real window would compact on its own at a moment the balancer cannot choose; declaring
one large window hands that decision to the balancer, which is what lets a session that hops between a
200k model and a 1M model be trimmed at a sensible point rather than whenever the smallest hop happens
to be reached. The declared **output** stays real: it caps one answer, not the conversation, so it is
the smallest output limit among the row's targets.

Two shares decide where the conversation is cut, and they measure different windows on purpose:

- the **global share** is a slice of the declared 1M, so `20%` always means 200k whatever is serving;
- a **per-model share** (the `%` field on a target) is a slice of that model's **own** window, so `50%`
  on a 200k model is 100k. It *overrides* the global rather than being capped against it.

The serving model's real window is the hard ceiling under either one, so a global `30%` means 300k
on a 1M model but is clamped when a 200k model is serving — you cannot tell the host to cut past what
the connector can hold. The ceiling sits a reserve *below* the window, because compacting is itself a
request against the same model and carries the conversation with it: triggering at the model's last
token is how a compaction trips the very overflow failure it exists to prevent. The reserve is a tenth
of the window or 20k, whichever is larger — the two agree at 200k — and never more than a quarter of a
window so small that 20k would swallow it. A model whose window the provider does not report has no
ceiling to clamp against, so the share stands alone.

The balancer watches `session.step.ended`, whose token counts are the same per-request figure the host
shows against the model's limit, and sums input, output, reasoning, and both cache fields. A session
the balancer never routed is never compacted, and a compaction already in flight is never doubled: the
guard re-arms only once the conversation is back under the threshold, or a failed compaction is
retried. Both shares are stored in the plugin's `settings` table (`context_percent`,
`context_percent:<row>:<provider>`).

There is no `compaction.buffer` any more: if you have one in your config, the balancer ignores it and
you can delete it.

## What counts as a failure

A provider failure is intercepted in the `retry` hook, before the session records a cut-off, so the
conversation only ever sees one when no other target is left. The host classifies each failure
itself and will not retry a deterministic one — a quota cap is exactly that — so the balancer sets
the retry decision rather than relying on it.

Anything unrecognised, arriving without a status, is treated as the account's fault. Providers
invent a new way to say "this account is spent" every few months, so a keyword list can never be the
test; a park is bounded and `use` clears it, whereas the opposite guess hands the message to the
user. Only two shapes are positively rejected, because another account would refuse them in the
same words:

- context overflow, which the compaction watcher handles instead;
- a content refusal.

The endpoint's own words, and its `retryAfterMs` when it gives one, are what the panel shows and how
long the account sits out — capped at an hour, so a mis-parsed value cannot strand it.

## The log

The panel's log records the first route a session takes and then every change, naming where it came
from and whether the previous target was parked. A failure that is *not* failed over is logged as
well, with its reason, so a cut-off in the conversation is always explained here.

## Deliberate limits

- **One model at a time.** The session is pinned to a family; the connector behind it changes,
  the model does not.
- **Pre-stream failover only.** A retry can hop connectors until the first token arrives; a
  stream already in progress cannot move.
- **No TUI.** OpenCode Desktop renders only plugins that export `./gui-experimental`. The V2
  plugin ships one (`v2/gui.tsx`); the V1 terminal dashboard cannot run there.

## Commands

```
/balancer help                        command list
/balancer status                      balancing state, account totals, rate-limited count
/balancer list [provider]             credentials in tried order, with markers
/balancer use <provider> <alias>      serve this provider with that credential
/balancer import                       re-read the credentials OpenCode holds
/balancer on | off                    toggle automatic failover
/balancer priority                     credential order with each one's switches
/balancer chain <model>                targets for a row, in the order they are tried
/balancer chain <model> add <provider> <model>
/balancer chain <model> remove|up|down <provider>
/balancer chain <model> reset          hand the row back to the credential order
/balancer enable <credential> | disable <credential>
/balancer free <credential> on | off   use only that credential's free models
/balancer up <credential> | down <credential>

`<credential>` is `<provider>`, meaning every credential that provider has, or `<provider>/<alias>`
for one of them.
```

Balancing defaults to **off**. Run `/balancer on` once accounts exist.

## Install

Clone this repository, then register the `v2` directory in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": [{ "package": "/absolute/path/to/opencode-balancer/v2" }]
}
```

OpenCode loads the server part from `exports["."]`. It provides `@opencode/plugin` at runtime, so
`node_modules` is not required to use the plugin.

## Develop

```sh
npx --yes bun test        # unit tests: account store, selection, failover marking, commands
```

## Desktop GUI

OpenCode Desktop 2.2+ loads the `./gui-experimental` part automatically, giving a Balancer side
panel with a balancing toggle, the accounts OpenCode holds, a chain editor per model, and the
provider order. The bundle is build output, and
upstream's `.gitignore` excludes `dist`, so build it once after cloning:

```sh
npx --yes bun run build:gui    # vite build → v2/dist/gui-experimental.cjs
```

Open it from the command palette (**Open Balancer**), the **Balancer** pill in the titlebar, the
**Balancer** tab in the side region, the side region's **+** menu, or by running `/balancer gui`.

## Upstream sync

`core/` files began as unmodified copies of the upstream plugin. Upstream has stopped moving, so
this is no longer a port: fixes and features land here first. If upstream ever resumes, diff
those files against its release before merging — everything in `server/` is V2-only and will
conflict by design.

## License

MIT. Derived from `@thelioo/opencode-balancer`, Copyright (c) the upstream author. See `LICENSE`.
