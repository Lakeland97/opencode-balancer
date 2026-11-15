---
"@thelioo/opencode-balancer": minor
---

Route per credential, and let the panel show and steer the whole thing.

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
