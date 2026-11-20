---
"@thelioo/opencode-balancer": patch
---

A row now re-checks the head of its order after the configured window even while the conversation keeps talking, instead of waiting for an idleness a busy session never reaches. The countdown shows the next check in both the desktop panel and the TUI.

A billing refusal such as "insufficient credits" now fails over to another credential. The host wraps these as `AI.Error.InvalidRequest`, and the wrapper's name was read as "the request's fault", so a spent account was handed to the session while a working one sat beside it.

Every row now declares the full thinking ladder. The host rejects a turn whose level is not listed on the selected model, and it does that before routing, so a level carried over from the previous model ended the turn with `Variant unavailable` on any row whose targets published no levels. A target that names no level still receives none: the level is removed from the request rather than sent to a provider that never advertised it.

Every attempt is now addressed to its own connector. The rewrite only ran on a URL that named the balancer stub, so a request the host had already bound to one provider kept that provider's host while receiving the next target's credential — SayGM's key arrived at Cline's endpoint, and the 401 that came back was charged to SayGM, which then looked limited for a reason that belonged to another service. The rewrite now runs on every attempt, and the base it works from is carried by the request itself instead of being read from a session binding a concurrent call can move.
