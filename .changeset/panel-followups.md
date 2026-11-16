---
"@thelioo/opencode-balancer": patch
---

Three panel follow-ups: an error you can read, a draft you can cancel, and an
all button that reaches everything.

A parked credential's note is now a disclosure. `▸` opens the provider's message
in full, wrapped across as many lines as it needs, with `last tried <time>`
underneath — the moment the router last pointed at the credential, which is the
attempt that parked it. `▾` folds it back to the single truncated line, and one
note is open at a time. The time was already in the panel's data, so nothing
about routing or storage changed.

`+ new chain` becomes `cancel` while the form is open, so a draft can be
dismissed rather than re-pressed. Starting a draft now opens the models section
it lives in, since a click that revealed nothing read as a no-op, and folding
that section — or completing a chain — drops the draft so no stale provider
carries into the next form.

`expand all` / `collapse all` now counts the models section as one more header,
so one click reaches every fold on the panel and the label describes what will
actually happen.

The panel is a built bundle, so a running window needs a reload to show these.
