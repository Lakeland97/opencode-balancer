# TUI and command parity

Status: design, awaiting approval
Date: 2026-11-16
Related: [model chains](model-chains.md), [follow-on ledger](../plans/2026-11-14-model-chains.md)

## Why

The balancer now has three surfaces with unequal reach. Desktop renders the full
panel through `v2/gui.tsx`; a terminal session gets only `/balancer` command
output; and the two do not always expose the same facts. The server and its RPC
already hold every value and action the panel uses, so the terminal can render
the same panel rather than a smaller status view.

The goal is a second renderer, not a second balancer. One routing store, one RPC
contract, one set of labels, and three ways to reach them: the Desktop panel, a
TUI panel, and commands.

## What parity means

Parity is capability, information, order and behaviour — not pixels.

- Every control on the Desktop panel is present in the TUI panel.
- Every read the panel shows (including a parked credential's reason and last
  attempt) is available from a command.
- Every write the panel makes is available from a command.
- A change made in one surface is visible in the others after their next
  refresh, because all three use the same store through the same server.
- Effects are part of parity. A write from a command does not merely reach the
  same end state: it writes the same event-log entry, drops the same routing
  memory, and invalidates the same cached catalogue as the panel's write.
- Labels and state words are the same everywhere. The TUI has no `ctx.t`, so
  the English strings come from one shared copy module rather than being
  retyped.

Commands stay terse and power-user shaped; they do not need menus or layout.
They are a complete alternative, not the primary experience.

## Goals

1. A V2 TUI part, exported as `./tui`, contributing a Balancer panel to the
   session side region.
2. Section-for-section parity with `v2/gui.tsx`, in the same order.
3. Keyboard-complete operation: no action requires a mouse.
4. Command parity for every read and write, with the same validation, side
   effects and event-log entries as the panel.
5. Shared formatting and copy so the three surfaces cannot drift.
6. Tests for the pure parts, and a manual parity pass against the matrix below.

## Non-goals

- No changes to the V1 plugin or `src/tui`. V1 targets an API OpenCode 2 does
  not load.
- No new routing, storage, compaction or failover behaviour.
- No redesign of the Desktop panel. Its layout and controls do not change; its
  labels come from the shared copy module and its writes call the shared
  setters, so all three surfaces behave alike.
- No mouse-only interactions.
- No npm publication. The publish gate stays as it is.
- No footer or titlebar indicator in the first pass. Entry is the command
  palette, `/balancer gui`, and a rebindable key.

## Anti-goals

- A read-only TUI status screen.
- A second store, a second routing decision, or direct database access from the
  TUI. It calls the same RPC as Desktop.
- Commands that can do less than the panel, or that drift in validation and log
  wording.
- Re-implementing the Desktop layout in a character grid literally at the cost
  of readability. Items and order are fixed; wrapping and widget choice may
  differ.

## What already exists

- `v2/index.ts` — V2 server part: hooks, credential sync, provider
  registration, compaction, `/balancer` command, `balancer_command` tool, and
  the `open` RPC event.
- `v2/rpc.ts` — `Balancer` RPC: 26 methods covering accounts, chains, settings,
  status and log, plus `events.open`.
- `v2/gui.tsx` — the Desktop panel and its entry points (side tab, titlebar
  pill, `+` menu, palette command, `/balancer gui` event).
- `v2/server/commands.ts` — the current command grammar.
- `src/tui/` — V1 terminal dashboard. Prior art for cursor-and-key handling,
  not reusable code.

The V2 TUI plugin API (`@opencode/plugin/tui`) provides:

- `Plugin.define({ id, setup })` and a `./tui` package export that the host
  loads automatically.
- A `session.panel` slot. The host owns sizing, focus and full-screen
  presentation; narrow terminals are forced full-screen. The slot receives
  reactive `name`, `sessionID`, `width`, `presentation`, `focused`, plus
  `focus`, `close` and `toggleFullscreen`.
- Panel-scoped keymap layers, promise-based `alert`/`confirm`/`prompt`/`select`
  dialogs, toasts, theme tokens, OpenTUI rendering, and the generated
  `client.rpc(...)` used by the GUI.
- OpenTUI JSX. Peer packages: `@opentui/core` and `@opentui/solid` (>= 0.6.6),
  and `solid-js` (>= 1.9.0).

## Architecture

```
v2/
  index.ts            server part (unchanged)
  gui.tsx             Desktop renderer
  tui.tsx             NEW: TUI entry, slot claim, entry points
  tui/
    panel.tsx         NEW: the panel component and its state
    items.ts          NEW: focus list, cursor and key reducer (pure)
    rows.ts           NEW: derived rows/sections from RPC data (pure)
  copy.ts             NEW: shared English labels
  core/format.ts      NEW: attempt time, markers, notes, token formatting
  server/settings.ts  NEW: setting writes shared by RPC and commands
  server/writes.ts    NEW: account/chain writes shared by RPC and commands
  server/commands.ts  extended grammar
```

The TUI imports `Balancer` from `v2/rpc.ts` and calls
`ctx.client.rpc(Balancer)` exactly as the GUI does. It never opens the SQLite
store.

`v2/package.json` gains:

```json
"exports": {
  ".": "./index.ts",
  "./tui": "./tui.tsx",
  "./gui-experimental": "./dist/gui-experimental.cjs",
  "./rpc": "./rpc.ts"
},
"peerDependencies": {
  "@opentui/core": ">=0.6.6",
  "@opentui/solid": ">=0.6.6",
  "solid-js": ">=1.9.0"
}
```

No TUI bundle is built. The host loads the source part, as the documentation's
`./tui` example does. `build:gui` remains the only Vite build.

## Panel

The panel claims:

```tsx
ctx.ui.slot({
  append: "session.panel",
  render: (panel) => (
    <Show when={panel.name === "balancer.panel"}>
      <BalancerPanel panel={panel} />
    </Show>
  ),
})
```

Entry points:

- A keymap command `balancer.open`, title `Open Balancer`, `palette: true`,
  default bind `ctrl+shift+b`. The command is named, so a user can rebind it;
  if the host reports the default as conflicting, the bind is dropped and the
  palette entry remains.
- The server's `/balancer gui` command emits `events.open`. The TUI subscribes
  from the panel and unsubscribes in its cleanup; the TUI context has no
  `ctx.signal`, so cleanup is the returned function or `onCleanup`, not a signal
  option. It opens `balancer.panel` when the event arrives.
- If no session is open, `panel.open` cannot succeed; show a toast: `Open a
  session first.`
- `f` toggles full-screen through `panel.toggleFullscreen`; the host ignores it
  when the terminal is too narrow for a side panel. `q` closes the panel through
  `panel.close` when no dialog owns the keyboard.

The panel is one scrollable column, with the same section order as Desktop.

### Header

- `Balancer` title.
- `balancing` toggle. Enter/Space flips it.
- `rebalance after` toggle and length. The toggle flips; the length opens a
  prompt prefilled with the stored value. Empty restores the built-in window;
  `0` turns the window off; any positive length turns it on. The same rule as
  the Desktop field and the RPC.
- `context limit` opens a prompt. The value is shown as stored. Below it, the
  same computed readout as Desktop: `at <cut>` for the declared 1M window.
- `buffer` opens a prompt, with the token readout when the value is a size.
  `enforce` opens a two-option select: `always`, `when necessary`.
- The message line shows the last failed RPC message; a success clears it.

### Providers

One block per credential in routing order, two lines each, as Desktop:

1. `[x] Provider / alias · in use|active|limited`. The `[x]` is the enable
   toggle. The markers use the same words and the same precedence as Desktop.
2. The control line: the parked note on the left, `[x] free`, `[use]`, and the
   grip `⠿` at the right.

The note is a disclosure. Enter opens it: the provider's message wraps over as
many lines as it needs, then `last tried <time>`. Enter again collapses it; one
note is open at a time. The note text is `resets <relative> · <reason>`, built
by the shared formatter.

### Models

Same header and body as Desktop:

- A fold control for the section, the `models` title, `+ new chain`, and
  `expand all` / `collapse all`. The all control includes the models section.
- While creating, the header button reads `cancel`. `+ new chain` opens a
  provider select, then a model select, then `chainCreate`; cancel clears the
  draft. Folding the section also clears it.
- Brand groups only when a brand has more than one row. A group has a fold
  control, its name, and the row count. Rows start folded, as Desktop.
- A chain row: fold control, label, `N · custom|automatic`, the model's own
  `limit` (prompt, empty follows global), and `reset` when the row is stored.
- A target: index, provider, model, `→ resolved` when substitution applies, and
  its state when not `available`. A grip reorders. `×` removes.
- `+ add target` opens a provider select (only providers not already used by
  the row), then a model select, then `chainAdd`. If every provider is used,
  show the same `every provider is already in this chain` note instead.

### Diagnostics

- A fold control `diagnostics`, the log-line count, and `refresh`.
- Open: the OpenCode app version (there is no bundle stamp, because the host
  loads the source part), when values were last read, credential/row/log counts,
  the stored context limit and computed cut, `clear` when the log is non-empty,
  and the log itself, newest last, time and text, route lines undimmed and other
  lines dimmed as in Desktop.
- Empty log: `nothing yet`.

## Input model

The panel is one focus surface, not a form. A pure reducer in `tui/items.ts`
builds a flat, ordered list of focusable items from the current state and moves
a cursor; the renderer highlights the item.

- `Up`/`Down`, `j`/`k`: move the cursor.
- `PgUp`/`PgDn`, `Home`/`End`: move by a page or to the ends.
- `Enter`/`Space`: activate the focused item — toggle a switch, open a fold,
  open a prompt/select, run `use`, remove a target, reset a row.
- `Tab`/`Shift+Tab`: move to the next/previous item without activating.
- `Left`/`Right`: leave a grip; otherwise no-op. Selects use dialogs.
- `r`: refresh. `f`: full-screen. `q`: close the panel.
- `Esc`: cancel the current dialog (host behaviour) or release a grabbed grip.

Reordering is a grab:

1. Focus a grip and press Enter. The row is marked `moving`.
2. `Up`/`Down` calls the same `move`/`chainMove` RPC the Desktop grip calls, one
   slot per press, so the outcome and the log entries match.
3. Enter drops the row; Esc releases it without another move.

Text is never edited inline. A prompt dialog is prefilled with the stored value
and commits on submit; cancelling changes nothing. This is the terminal-native
equivalent of Desktop's commit-on-blur fields, with the same validation from the
RPC.

Scrolling keeps the focused item visible. If the host's scrollbox does not
expose the needed control on the version in use, window the list by the
renderer height the way the V1 dashboard does; the focused item must never be
off-screen.

## Live behaviour

- On mount, `refresh()` reads status, accounts, chains, priority, limit, buffer,
  rebalance and log in one `Promise.all`, exactly as the GUI.
- Every two seconds, run the same full `refresh()`. The GUI kept its poll to
  `list` and `log` because a poll must not overwrite a field being typed into;
  the TUI has no inline fields — text and selection live in modal dialogs — so
  that reason does not apply. Full polling keeps switches, order, models and
  settings live too, and a failed poll leaves the last good answer.
- The one exception is an active grip grab: skip the poll while a row is
  grabbed, so the list cannot shift under the cursor, then refresh after the
  drop or release. Dialogs are unaffected: they hold their own value.
- Every mutation goes through a `run` wrapper: on `ok: false` show the message;
  on success clear it and refresh in full. This matches `v2/gui.tsx`.
- Changes made in Desktop appear in TUI on the next poll, and the reverse. No
  cross-client events are required beyond the existing `open`.

## Commands

Commands gain the missing reads and writes. Existing grammar stays; state words
and side effects align with the panel.

```
/balancer errors                              parked credentials in full
/balancer settings                            limit, buffer + enforcement, rebalance, cut
/balancer chains                              rows the panel shows, with limits and counts
/balancer limit <value|default>               size in thousands or share; default clears
/balancer buffer <value> [always|necessary]   set the room, optionally enforcement
/balancer buffer <always|necessary>           change enforcement alone
/balancer buffer default [always|necessary]   built-in rule, optionally enforcement
/balancer rebalance on [length]               window on, optionally at a length
/balancer rebalance off                       window off
/balancer rebalance <length>                  set it; positive on, 0 off
/balancer rebalance default                   clear the stored length, built-in window
/balancer chain <model> limit <value|default> this model's own limit
/balancer create <provider> <model>           register a row for a model
/balancer log [n]                             recent lines, newest last
/balancer log clear
/balancer diag                                counts, store path, settings, log size
```

- Values that contain spaces are quoted: `/balancer rebalance "1d 2h"`. The
  parser already honours quotes; help says so.
- `default` is the reset keyword everywhere a stored value can be cleared. It
  is a word rather than an empty argument because `parseArgs` cannot produce an
  empty token without literal quotes, which reads as a mistake.
- `rebalance off 90m` is rejected: a length turns the window on by the panel
  field's own rule, so `off` plus a length is contradictory. `on 90m` is
  allowed and means "on, at 90m".
- A verb that carries two settings validates both before writing either. Each
  setting changed writes its own `config` log line through the shared setter,
  and the replies are joined by newlines. A failure changes nothing.
- `errors` is the command twin of the credential note: every parked credential
  with `resets <relative>`, the reason, `last tried <time>`, and its markers. A
  credential with no park is not listed.
- `chains` is the command twin of the models section's row list: the rows the
  panel shows (stored or multi-target), each with its key, limit as typed,
  custom/automatic, and target count. `chain <model>` remains the detail view.
- `chain <model>` adds the model's own limit and each target's `resolved` and
  state, so it matches what the row shows.
- `create` is the command twin of `+ new chain`; it registers a row for a model
  that is not in any chain. `chain <model> add ...` remains the way to add a
  target to an existing row.
- `gui` says `Open the Balancer panel`, not `Desktop panel`, and its fallback
  text no longer assumes Desktop.
- `help` lists the new verbs. `log n` defaults to the last 50 lines; `log clear`
  clears the stored log.

### Shared writes, including the existing verbs

Every write — existing and new — goes through the same functions the RPC
handlers use: `server/settings.ts` for settings, `server/writes.ts` for account
and chain writes. Today `on`/`off`, `enable`/`disable`, `free`, and `use` call
core mutators directly: they skip the RPC's `forgetRoutingMemory`, skip the
`config` log entry, and `free` invalidates the catalogue in one path but not the
other. That is the drift this design removes.

The shared functions own validation, their `config` log line, routing-memory
invalidation, and catalogue invalidation where a change affects which models
can serve (`setFreeOnly` in particular). The RPC handlers and the command
parser both call them. Readable success sentences stay recognisably the same,
but the side effects now match wherever the write came from. This is a
deliberate change to current command behaviour, and it is covered by command
tests.

### State words and predicates

The panel's definitions win; commands adopt them.

- `active` — the balancer can send here: `!disabled && !limited`. It does not
  mean the provider's stored alias. `/balancer active <provider>` still reports
  that stored choice; `list` does not label it `active`.
- `limited` — `rateLimitedUntil != null`: failed and not retried yet, regardless
  of the clock. It is not a countdown. `list` prints `limited` plus
  `resets <relative>` when the endpoint named one; `errors` adds the reason and
  `last tried <time>`.
- `in use` — the credential that served the most recent request.
- `disabled` — switched off. The panel draws it as an unchecked box; commands
  print `disabled`.
- A target's state is the row's own state word (`available`, `unavailable`,
  and so on). `chain <model>` stops saying `no healthy account`; it prints the
  state the panel prints.
- `/balancer status` counts any park, not only unexpired ones, matching the
  panel's `limited` count.

The shared marker/note helpers in `core/format.ts` implement these definitions,
so the three surfaces cannot disagree about what a word means.

## Shared copy and formatting

The TUI context has no `ctx.t`. To keep the words identical:

- `v2/copy.ts` exports the English labels already in the GUI's `en` table.
  `gui.tsx` uses those values in its i18n table; `tui/panel.tsx` imports them
  directly. The GUI keeps `ctx.t(...)` at call sites, so translation remains
  possible later.
- `v2/core/format.ts` exports `formatAttempt`, marker composition
  (`in use`/`active`/`limited`), note composition (`resets ... · reason`), and
  reuses `formatTokens`/`formatRollover`/`formatDuration`.
- `commands.ts` uses the same note and marker helpers instead of its own
  concatenation. Command prose (sentences such as "Context limit is 200k") stays
  in the command layer; state words do not diverge.

## Parity matrix

This table is the acceptance contract. Every row must be true before the work is
called done.

| Desktop control | TUI | Command |
|---|---|---|
| `balancing` toggle | Enter on the toggle | `on` / `off` |
| `rebalance after` toggle | Enter on the toggle | `rebalance on` / `rebalance off` |
| rebalance length | prompt | `rebalance <length>` / `rebalance default` |
| context limit | prompt | `limit <value>` / `limit default` |
| buffer | prompt | `buffer <value>` / `buffer default` |
| enforce | select | `buffer always` / `buffer necessary` |
| `at <cut>` readout | text | `settings` |
| provider enable | Enter on `[x]` | `enable` / `disable` |
| provider markers | text | `list`, `priority` |
| parked note + `last tried` | Enter disclosure | `errors` |
| `free` | Enter on `[x] free` | `free on` / `free off` |
| `use` | Enter on `use` | `use` |
| provider reorder | grip grab + arrows | `up` / `down` |
| models fold | Enter | `chains` |
| `+ new chain` / `cancel` | Enter; provider+model dialogs | `create <provider> <model>` |
| `expand all` / `collapse all` | Enter | — |
| brand fold | Enter | — |
| chain fold | Enter | — |
| model limit | prompt | `chain <model> limit <value>` / `... default` |
| `reset` | Enter | `chain <model> reset` |
| target list, `resolved`, state | text | `chain <model>` |
| target reorder | grip grab + arrows | `chain <model> up <provider>` / `chain <model> down <provider>` |
| target remove | Enter on `×` | `chain <model> remove <provider>` |
| `+ add target` | provider+model dialogs | `chain <model> add <provider> <model>` |
| `diagnostics` fold | Enter | `diag` |
| `refresh` | `r` | `import` for credentials; reads are stateless |
| log / `clear` | fold, Enter on `clear` | `log [n]` / `log clear` |
| message line | text | command output |
| open the panel | palette, `ctrl+shift+b`, `/balancer gui` | `gui` |

The dashes are not missing features: commands are already row-oriented, so
folding a UI section has no command meaning. The information behind the fold
(the row list, its targets, its limits) is reachable through `chains` and
`chain <model>`.

## Packaging and loading

- `v2/package.json` gets `./tui` and the OpenTUI peers.
- The local plugin entry in `~/.config/opencode/opencode.json` already points at
  the `v2` directory; no configuration change is needed.
- OpenCode loads the TUI part beside the server and GUI parts. The GUI bundle is
  untouched and still needs `build:gui`; the TUI part is source, so a plugin
  reload/reconnect is enough.
- If the V2 package is ever published, the published artifact must include the
  `.tsx` sources and peer declarations. That is out of scope while the npm
  question is open.

## Verification

1. Pure tests for `tui/items.ts`: cursor order, page/home/end, grab-and-move,
   Enter dispatch, and the rule that one note is open at a time.
2. Pure tests for `tui/rows.ts`: provider grouping, marker precedence, note
   composition, `allCollapsed` including models, and target `resolved` display.
3. Command tests for each new verb and for the migrated existing verbs:
   success, validation failure, the `config` log entry, and the routing-memory
   or catalogue effect. Reuse the existing temp-database pattern.
4. `lint`, `checktypes`, `bun test`, `build:gui`.
5. Manual parity pass with Desktop and a terminal open on the same session:
   change a value in each surface and watch the other pick it up; walk the
   matrix top to bottom; exercise a parked credential, a long error, a reorder,
   a new chain, add/remove target, and clear log.
6. Narrow terminal (about 60 columns) and full-screen; the host may force
   full-screen. No control may be unreachable, and no focused item may sit
   off-screen.

## Risks

- The TUI plugin API is new. Confirm loading, the panel slot, and panel-scoped
  keymaps with a thin vertical slice before building the full panel.
- `session.panel` is host-sized; a very narrow panel may wrap the control line.
  Preserve Desktop's two-line structure and let the control line wrap under the
  note if needed.
- Polling and panel lifetime: stop the interval and RPC event subscription on
  cleanup; the plugin may be reloaded without restarting OpenCode.
- Commands and panel can drift. The shared setters and formatters are the
  guardrail; a new panel control must add a command row to this matrix.

## Decisions made here

These are builder calls, not open questions:

- Panel name `balancer.panel`; TUI plugin id `balancer.tui`.
- Dialogs for text and selection; no inline editing.
- Grip reordering is grab-and-move, not live arrow movement.
- Keyboard is the required input; mouse support is optional and not part of
  parity.
- No footer/titlebar indicator in the first pass.
- Commands stay verb-and-argument shaped; no interactive shells.
- All writes, existing and new, go through the panel's shared setters. The
  existing verbs' grammar and readable output stay, but their side effects
  (routing-memory reset, `config` log line, catalogue invalidation) now match
  the panel's.
- The panel's definitions of `active`, `limited`, `in use`, `disabled` and a
  target's state are authoritative; commands adopt them.
- The TUI polls the full panel state every two seconds, pausing only while a
  grip is grabbed. It is at least as live as the GUI.
- `default` is the reset keyword for stored values; a two-setting verb
  validates both parts before writing either.
