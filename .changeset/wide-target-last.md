---
"@thelioo/opencode-balancer": patch
---

When every target in a row has a smaller window than the conversation already fills, the balancer still routes the request (to one of the row's targets) instead of leaving it pointed at the stub. The provider's own refusal then names the size problem, and compaction can shrink the conversation, rather than the call failing as an unreachable host.
