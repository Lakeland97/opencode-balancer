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
| `core/` account store, schema, priority | unchanged from upstream |
| Credential capture | V2 `integration.connection.resolve` instead of `auth.json` |
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
3. On `model.request` the plugin chooses the connector in provider-priority order, then rewrites
   the API root, the credential, and the body's `model` field to that connector's own id.
4. `http.response` parks a limited connector; `retry` moves the call to the next like-for-like
   connector, so failover crosses providers.

Families never mix wire formats: a model offered as `anthropic-compatible` gets its own row,
because routing only rewrites the `model` field and the request shape stays whatever the package
built.

## Model chains

Each row is an ordered list of **targets**, one per provider. A row starts in **automatic** order,
which is just the provider priority. Editing the order — by adding, moving or removing a target —
stores the list, and from then on the row routes exactly as written until you `reset` it.

A target is any model the provider can actually route, so a chain may hold unrelated models.
Providers are still the unit of health: the same provider cannot appear twice, because the second
target would never be reached.

```sh
/balancer chain deepseek-v4.1-flash                        # targets, in the order they are tried
/balancer chain deepseek-v4.1-flash add commandcode deepseek-v4.1-flash
/balancer chain deepseek-v4.1-flash up commandcode
/balancer chain deepseek-v4.1-flash remove commandcode
/balancer chain deepseek-v4.1-flash reset                  # back to provider priority
```

A provider can also be told to serve **free models only** — useful when you keep no
credits on an account. The balancer then points that provider at its own free spelling
of the model the chain matched (`deepseek-v4.1-flash` becomes
`deepseek-v4.1-flash-free` where the provider offers one) and skips the target when it
has none. A model counts as free when it is priced at zero or its id carries a `free`
marker.

```sh
/balancer free opencode on           # paid models are never sent to this provider
/balancer free opencode off
```

The Desktop panel edits the same chains: `↑ ↓ ×` per target, `+ add target` with provider and model
pickers, and a `reset` on any customised row. It also lists providers, with an enabled checkbox and
the same `↑ ↓` ordering controls.

### Context windows

A row declares the **smallest** context window in its chain, because every target must be able to
take over the same conversation. `compaction.buffer` is a share of the declared window, so the host
would compact early if the declared window were the real one. The plugin compensates: with a real
window of 200k and a 75% buffer, the row declares `200k / (1 − 0.75) = 800k`, and the host compacts
at 200k — where the smallest target actually ends. The same applies to output limits, which use the
smallest output limit in the chain.

The buffer is read from `opencode.json[c]` (env, project, then global) when the plugin loads, since
the plugin API exposes no config accessor. With `compaction.auto: false` nothing trims the
conversation, so routing also skips targets smaller than the request's estimated token count.

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
/balancer list [provider]             accounts with active/disabled/limited markers
/balancer add <provider> <alias>      save the provider's current credential as an account
/balancer use <provider> <alias>      make an account active
/balancer remove <provider> <alias>
/balancer rename <provider> <alias> <new>
/balancer on | off                    toggle automatic failover
/balancer priority                     provider order and on/off state
/balancer chain <model>                targets for a row, in the order they are tried
/balancer chain <model> add <provider> <model>
/balancer chain <model> remove|up|down <provider>
/balancer chain <model> reset          hand the row back to provider priority
/balancer enable <provider> | disable <provider>
/balancer free <provider> on | off     use only that provider's free models
/balancer up <provider> | down <provider>
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
panel with account actions, a balancing toggle, an add form, a chain editor per model, and the
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
