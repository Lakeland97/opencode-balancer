---
"@thelioo/opencode-balancer": patch
---

A provider configured with its own key now becomes an account without a restart, and three routing mistakes are fixed.

- Providers whose key lives in `opencode.json` rather than in OpenCode's credential store are imported during the account sync, so a freshly added provider can serve on the next request instead of never.
- The plugin also watches `provider.updated` and `config.updated`. Provider edits are debounced, and the echo from the balancer's own model reload is ignored, so adding or removing a provider no longer needs an application restart.
- A re-import no longer counts as a new credential. That miscount rebuilt the provider on every sync, which interrupted in-flight requests and made the balancer look like it was failing over and parking providers for no reason.
- Failover skips any target whose own window is smaller than the conversation already fills. Previously a large conversation could be handed to a smaller variant of the same model and be rejected outright.
- A row's `in use` marker now comes from the target that row itself served, not from whichever credential served any model most recently. A limited provider can no longer be shown as in use while another target is answering.
