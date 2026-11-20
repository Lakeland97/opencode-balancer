---
"@thelioo/opencode-balancer": patch
---

A fresh process no longer caches a model list in which a provider has not appeared yet. The first catalogue read after the host starts can happen while a connector is still loading, and its model looked absent for the next half minute — long enough for a row with one healthy credential to call its one working target "no longer offers it" and hand the session an error instead of trying it. A catalogue with a missing target is now treated as a fact about the moment and re-read on the next request.

The credential marker that means "served the most recent request" now reads `last served`. `in use` sounded like a claim about the present, so a row that had served once and was then parked showed `limited` and `in use` together, which read as a contradiction rather than as the history it is.
