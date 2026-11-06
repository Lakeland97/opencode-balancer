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
| Failover | `session.hook("retry")` forces a retry; the next request selects another account |
| Control surface | `/balancer` command + `balancer_command` tool, replacing the terminal dashboard |

## Deliberate limits

- **Account-level failover only.** `SessionContext.model` is readonly in V2, so the plugin cannot
  switch *providers* mid-request. Multiple accounts for the same provider work; the provider
  priority matrix only affects which model a provider is configured with.
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
/balancer model <provider> <modelID>
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

Open it from the command palette (**Open Balancer**) or the Balancer panel in the side region.

## Upstream sync

`core/` files are unmodified copies. When rebasing on a new upstream release, diff that directory
against the published tarball first — those files should merge cleanly, and everything in
`server/` is expected to conflict.

## License

MIT. Derived from `@thelioo/opencode-balancer`, Copyright (c) the upstream author. See `LICENSE`.
