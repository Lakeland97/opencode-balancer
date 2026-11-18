---
"@thelioo/opencode-balancer": patch
---

Find model variants from the words people actually type, and fail over on a timeout even when the host words it as an abort.

`deepseek 4.1` now matches `deepseek-v4.1-flash`, `-eco` and `-cloud` instead of returning no match. When several variants tie, the command and panel list their exact ids rather than choosing the first; naming the variant still resolves exactly. A spaced query and the `v` in a version no longer spell a different model.

A stream cut for taking too long is classified as the account's availability before the user-abort pattern, so a slow model fails over instead of surfacing "The operation was aborted". Bound routes now live for an hour and are refreshed by each HTTP attempt, so an attempt longer than five minutes no longer re-routes its own retry through another account.
