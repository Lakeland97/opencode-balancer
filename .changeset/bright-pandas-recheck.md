---
"@thelioo/opencode-balancer": patch
---

A row now re-checks the head of its order after the configured window even while the conversation keeps talking, instead of waiting for an idleness a busy session never reaches. The countdown shows the next check in both the desktop panel and the TUI.

A billing refusal such as "insufficient credits" now fails over to another credential. The host wraps these as `AI.Error.InvalidRequest`, and the wrapper's name was read as "the request's fault", so a spent account was handed to the session while a working one sat beside it.
