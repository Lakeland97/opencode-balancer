---
"@thelioo/opencode-balancer": minor
---

The panel no longer has a status area of its own. What is serving is reported
on the credential that is serving it, in the note under its name: the model,
the thinking level actually applied, and when it last answered. A credential
that is limited keeps showing its reset time and the provider's own words.

Also in this release:

- Every target in a chain row shows the connector's own name for the model
  (`DeepSeek V4.1 Flash 1017`, `… Fast`, `… Free`) with the id beside it. Ids
  repeat across a row — six providers spell the same weights
  `deepseek-v4.1-flash` — so the name is what tells them apart.
- The context readout measures the serving target's own window instead of the
  tightest window in the row, so a 1M model is no longer cut at a 200k
  sibling's figure.
- A failover walk that produced no answer restores the row's bound target and
  its last-served note, so the next failure is charged to the provider that
  actually answered rather than the one that happened to be tried last.
