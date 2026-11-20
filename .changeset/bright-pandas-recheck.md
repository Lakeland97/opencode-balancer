---
"@thelioo/opencode-balancer": patch
---

A row now re-checks the head of its order after the configured window even while the conversation keeps talking, instead of waiting for an idleness a busy session never reaches. The countdown shows the next check in both the desktop panel and the TUI.

A billing refusal such as "insufficient credits" now fails over to another credential. The host wraps these as `AI.Error.InvalidRequest`, and the wrapper's name was read as "the request's fault", so a spent account was handed to the session while a working one sat beside it.

A row now offers three thinking levels — `low`, `medium`, `high` — instead of every name its connectors happen to publish. The host rejects a turn whose level the selected model does not declare, and it does that before routing, so the row declares all three; a target's own ladder is then folded onto their tail. Its highest rung is what `high` means, the rung below that is `medium`, and everything earlier is `low`, which is the table a five-rung target follows: 1/2/3 → low, 4 → medium, 5 → high. A target that publishes no levels receives none at all: the level is removed from the request rather than sent to a provider that never advertised it. A session saved under the previous seven-level row has to choose one of the three once, because the host validates the saved level before the balancer is consulted.

Every attempt is now addressed to its own connector. The rewrite only ran on a URL that named the balancer stub, so a request the host had already bound to one provider kept that provider's host while receiving the next target's credential — SayGM's key arrived at Cline's endpoint, and the 401 that came back was charged to SayGM, which then looked limited for a reason that belonged to another service. The rewrite now runs on every attempt, and the base it works from is carried by the request itself instead of being read from a session binding a concurrent call can move. A target the walk could not reach is now recorded instead of disappearing, and a row that ends with nothing to serve names why each target was skipped.
