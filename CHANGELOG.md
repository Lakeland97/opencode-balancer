# @thelioo/opencode-balancer

## 0.3.3

### Patch Changes

- a9583c0: Make the panel's controls read as controls, and give a credential row two lines.

  Every button is now enclosed — a `currentColor` border, a radius and padding — so
  it reads as something to press rather than as a word that happens to react to a
  click. Each dropdown sits in a frame of its own with a `▾` beside it, because the
  host's native arrow is faint in this panel and the arrow is what says "a list
  opens".

  Section titles are fold controls too: clicking `models`, a brand header such as
  `claude`, or a model's own label opens or closes it. The little chevron buttons
  stay where they were, so a keyboard still has a real control to focus.

  A credential row now has two lines. The first is who it is: the checkbox, the
  name, and its markers. The second is what you can do to it: the refill the
  endpoint named and the error it threw on the left, then a hairline, `free` and
  `use`, and the reorder grip at the far right. Narrow windows used to produce
  that shape only when the flow happened to wrap, and a parked credential's reason
  was reachable only by hovering `limited`. It is now readable in place, cut to the
  line with the full text on hover.

  The panel is a built bundle, so a running window needs a reload to show it.

## 0.3.2

### Patch Changes

- a6130e6: Reorder by dragging, instead of with `↑`/`↓` buttons.

  The credential rows and a row's targets each carried a pair of step buttons. Each
  row now has one grip in a right-hand gutter — the same place on every row, and out
  of the flow so a wrapping label cannot push it around: drag it onto the row whose
  place it should take, and it moves all the way there in one gesture.

  Nothing about the order changed. Credentials are still one flat list in the order
  requests take them, a row's targets are still an ordered list of their own, and a
  drop names the slot it landed on rather than a direction. With the grip focused,
  the arrow keys still move the row one place, so reordering does not require a
  mouse.

  The panel is a rebuilt bundle, so the running window needs a reload to show it.

## 0.3.1

### Patch Changes

- 0b6d1a6: Hold the compaction reserve to a floor: the size of the summary prompt itself.

  Compacting sends the conversation **plus** a summarization instruction, and the
  buffer is the room reserved for that request. A very small buffer — `1%` on a
  small model — could reserve less than the instruction the request carries,
  leaving the summary request itself over the window it was meant to stay under: the
  same overflow, reached from the other side. A reserve below that size is now
  raised to it, so the cut lands slightly earlier exactly where it has to.

  The size is measured rather than assumed. The balancer sees the compaction request
  go past, reads the instruction the host appended, rounds it to the nearest
  thousand, and remembers it, so the floor follows the host if its prompt ever
  changes; the host's short retry reminder is ignored so it cannot overwrite a real
  measurement. Until the first compaction has been watched the figure stands at what
  the host's own prompt measured when this was written.

  Nothing in the panel changes: the context limit and the buffer are shown as typed,
  and the floor only moves the trigger.

## 0.3.0

### Minor Changes

- 957555a: Route per credential, and let the panel show and steer the whole thing.

  A **credential** — one provider key, not the provider — is now the unit of
  routing. Each gets its own row in the panel with `use`, `enable`, `free` and
  `↑↓`, so a provider's second key is a second chance rather than a duplicate.
  OpenCode's own credentials are imported on first run instead of added by hand,
  and `use` on a parked credential clears its cooldown.

  **Failover is reactive.** A provider failure is caught before the session sees
  it, the credential that raised it is parked, and the request goes to the next
  one. Routing is sticky **per model row** within a session — a session may run
  more than one model, and each keeps its own pinned target, its own trail of
  tried credentials, and its own give-up count. An idle window (`rebalance after`,
  a toggle and a length in the panel) restarts the order from the head once a
  session has sat still, measured from the last routed request. When nothing
  healthy can answer a row at all, the row's head is tried anyway rather than
  leaving the call pointed at a stub.

  **Context is the balancer's decision.** Every balancer model reports a 1M window
  so the host does not compact at a moment the balancer cannot choose; the cut is
  then the tightest of the models a session actually ran, auxiliary calls (a
  title, a summary, a one-off generation) excluded. The limit takes a size or a
  share, the buffer comes off it, and `enforce` decides whether the reserve is
  taken always or only where the limit has reached what the model can hold.

  **The panel says what happened**: `in use` for the live target, `limited` for a
  credential that failed and has not been retried yet, and the refill a provider
  named (`resets 14:21`, `resets Nov 26 14:21`). Wording is English-only, and a
  model's own field is labelled with the cut it produces (`at 304k`).

## 0.2.18

### Patch Changes

- 3535f76: Read auth.json from the same directory opencode writes it on Windows (`~/.local/share/opencode`, matching xdg-basedir) instead of `%LOCALAPPDATA%`, so accounts connected through the native provider flow are saved.

## 0.2.17

### Patch Changes

- 293877b: Fix arrow-key navigation in the dashboard and priority screens when the plugin is installed from npm. opencode's route computation could track the screens' selection signals through opentui's runtime bridge, remounting the screen on every key press and resetting the selection; the selection state now lives at module scope so it survives those remounts.

## 0.2.16

### Patch Changes

- d4cd624: Upgrade @opentui/solid to 0.4 so TUI components resolve a real jsx-runtime module when the plugin is installed from npm; 0.2 only shipped jsx-runtime.d.ts, which crashed activation with "Export named 'jsxDEV' not found" whenever the plugin lived under node_modules.

## 0.2.15

### Patch Changes

- 766f207: Skip schema table recreation when the migration is already applied, fixing "database is locked" and "no such table: accounts_new" races between concurrent server and TUI plugin instances.

## 0.2.14

### Patch Changes

- 0e4aabd: Restore Balancer TUI command registration for opencode builds that use the command API.

## 0.2.13

### Patch Changes

- 3d90b41: Register the Balancer dashboard command through OpenCode's current TUI keymap API so `/balancer`, `Ctrl+B`, and the command palette work on OpenCode 1.17.18.

## 0.2.12

### Patch Changes

- 7e29ed3: Fix the Balancer TUI on OpenCode 1.17.18:

  - Register the dashboard command through OpenCode's TUI command shim (`api.command.register`) when available so `/balancer`, `Ctrl+B`, and the "Open Balancer Dashboard" palette entry appear again, keeping the keymap layer as a fallback for newer runtimes.
  - Fix dashboard arrow-key navigation resetting the selection every ~500ms: the dashboard poll re-set its `accounts` and `usage` signals with fresh identities on every tick, which made OpenCode re-render (remount) the route and reset the cursor. The poll now only updates those signals when the underlying data actually changed.
  - Fix the selected-row highlight being invisible on themes with a transparent `backgroundElement`. The selection now uses the theme's `primary` color with an opencode-style selected foreground, matching how opencode highlights its own list selections.
  - Fix the dashboard appearing frozen after adding an account: opencode opens (and briefly keeps re-opening) its native model picker on top of the dashboard after a provider connects, capturing the keyboard until the user pressed Esc. The connect flow now dismisses that lingering picker so control returns to the dashboard automatically.
  - Use Windows-specific environment fallbacks (`USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `LOCALAPPDATA`) when resolving the config and data directories so the plugin initializes on Windows.

## 0.2.11

### Patch Changes

- aa105ac: Fix the balancer dashboard crashing with "No renderer found". The TUI components are now shipped as source so opencode's runtime plugin transforms them at load time and they share opencode's `@opentui/solid` renderer context, while the entrypoint stays compiled so the plugin still initializes.

## 0.2.10

### Patch Changes

- 3189ae3: Export the compiled TUI entrypoint so current opencode versions can initialize the dashboard plugin.

## 0.2.9

### Patch Changes

- e4b36ea: Dummy patch release to verify the startup auto-update end to end.

## 0.2.8

### Patch Changes

- a6beec6: Fix the plugin auto-update never running. The check now runs when the plugin
  loads, on every opencode start. Detecting a newer release clears the stale
  cached `@latest` sandbox and opencode reinstalls the new version on its own,
  with no toast or restart prompt.

## 0.2.7

### Patch Changes

- 7538af1: Publish another dummy patch release to test deferred plugin cache auto-update behavior.

## 0.2.6

### Patch Changes

- 4f43755: Run the plugin cache update check after the first root session is created, matching the deferred startup pattern used by other opencode plugins.

## 0.2.5

### Patch Changes

- e483c2d: Publish a dummy patch release to test plugin cache auto-update behavior.

## 0.2.4

### Patch Changes

- 809fdf6: Invalidate only the active outdated `@latest` opencode plugin cache sandbox after detecting a newer npm release, then notify the user to restart opencode.

## 0.2.3

### Patch Changes

- 752d8e9: Show the plugin version in the dashboard title.

## 0.2.2

### Patch Changes

- a3b2716: Mitigate intermittent SQLite lock failures by configuring a connection-level busy timeout during database initialization.

## 0.2.1

### Patch Changes

- 2843fae: Document plugin installation instructions using the unversioned package entry instead of `@latest`.

## 0.2.0

### Minor Changes

- c83caf5: Add the new TUI-driven balancer workflow.

  This release replaces the legacy command-centric balancer with a dedicated opencode TUI dashboard and server/core architecture for managing multiple accounts, provider/model priority, and automatic failover.

  - Add a Balancer dashboard available from `Ctrl+B`, `/balancer`, the command palette, and the sidebar.
  - Add account management from the TUI, including native provider connection, account activation, rename/remove flows, duplicate-account refresh, and selected-account status syncing.
  - Add a provider priority matrix for enabling balancing, choosing one model per provider, reordering failover priority, and disabling providers from automatic routing.
  - Add automatic retry/failover for retryable provider responses, marking rate-limited accounts temporarily unhealthy and switching to another healthy saved account when available.
  - Add local SQLite-backed storage for accounts, provider state, pending native connections, usage snapshots, priority settings, and balancer events.
  - Add usage snapshot support for supported providers and display usage in the dashboard/sidebar status surfaces.
  - Update packaging and docs for the TUI plugin entry point, Bun lockfile workflow, Changesets-based releases, and the new installation/setup guide.
