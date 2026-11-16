---
"@thelioo/opencode-balancer": patch
---

Open the TUI panel from the command palette and `ctrl+shift+b`, and keep each model request on one account.

The TUI keymap layer now opts into global mode, so its palette entry and shortcut stay reachable while a dialog or the prompt owns input.

Routing binds the account chosen for a model request to that request's HTTP retries. Re-selecting for every retry let one attempt fail on several providers and charged the wrong account with the last error. Title and one-off generation calls now follow the conversation's account without replacing its failure target.
