# opencode-balancer (V2 port)

A port of [`@thelioo/opencode-balancer`](https://github.com/thelioo/opencode-balancer) to the
OpenCode 2 plugin API. Keeps multiple accounts per provider and fails over to a healthy one when
the active account is rate limited.

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

## Deliberate limits

- **One model at a time.** The session is pinned to a family; the connector behind it changes,
  the model does not.
- **Pre-stream failover only.** A retry can hop connectors until the first token arrives; a
  stream already in progress cannot move.
- **No TUI.** OpenCode Desktop renders only plugins that export `./gui-experimental`, which
  upstream does not provide.

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
/balancer priority
/balancer model <provider|all> <name>   like-for-like model; accepts the picker's label
/balancer equivalents [name]            which model each connector uses for a family
/balancer enable <provider> | disable <provider>
/balancer up <provider> | down <provider>
```

Balancing defaults to **off**. Run `/balancer on` once accounts exist.

## Install

Register the repository as a plugin directory in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["/Users/user/Scripts/git/opencode-balancer/v2"]
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
panel with account actions, a balancing toggle, and an add form. The bundle is build output, and
upstream's `.gitignore` excludes `dist`, so build it once after cloning:

```sh
npx --yes bun run build:gui    # vite build → v2/dist/gui-experimental.cjs
```

Open it from the command palette (**Open Balancer**), the **Balancer** pill in the titlebar, the
**Balancer** tab in the side region, the side region's **+** menu, or by running `/balancer gui`.

## Upstream sync

`core/` files are unmodified copies. When rebasing on a new upstream release, diff that directory
against the published tarball first — those files should merge cleanly, and everything in
`server/` is expected to conflict.

## License

MIT. Derived from `@thelioo/opencode-balancer`, Copyright (c) the upstream author. See `LICENSE`.
