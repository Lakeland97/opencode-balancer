---
"@thelioo/opencode-balancer": minor
---

Failover now happens inside the call, so a spent credential no longer reaches
the conversation. A routed request that a provider refuses with a retryable
status is parked and re-sent to the next target of the same row before the
session sees it; from the client's side the turn is simply slower. When every
target is genuinely spent, the session gets the provider's own refusal plus one
status message naming what is exhausted, when each credential returns, and where
to add a target.

Also in this release:

- One picker row per model, matched on id and title. Version punctuation folds
  (`claude-fable-5-2` and `claude-fable-5.2` are one row), a shared title merges
  rows that differ only in spelling, and a price marker (`paid`/`free`) is never
  merged away. Rows that still share a title are told apart by what their key
  adds, so `Hy3` and `Hy3 (paid)` are distinguishable choices.
- The panel's in-use readout names the agent, the connector's real model id and
  the thinking level actually applied, instead of the row label and the level
  requested. The TUI renders the same lines.
- `+ add target` offers only the models whose wire format the row can carry, so
  it can no longer propose a choice the add would refuse. The picker's model list
  loads against the row's own package.
- Rows are compared field by field across the panel's poll, and unchanged rows
  keep their object identity. A refresh no longer rebuilds the rows, which is
  what closed the model picker before a selection could be made.
