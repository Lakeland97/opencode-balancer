---
"@thelioo/opencode-balancer": patch
---

A row's `in use` marker now comes from the target that row itself last served, rather than from the globally most recently used credential. A limited provider can no longer be shown as in use while another target is answering.
