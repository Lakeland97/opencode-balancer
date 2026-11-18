---
"@thelioo/opencode-balancer": minor
---

The panel says whether a routed model is answering right now. A row that is
generating reads `build · open-design/deepseek-v4.1-flash (high) · working`
instead of a countdown that keeps climbing while it waits, and the countdown
itself is now measured from the answer rather than from the request, so a slow
model no longer reads as an idle one.

Also in this release:

- When nothing can route a row, the target that last answered it is tried
  instead of an arbitrary one, so a session keeps working on the model it was
  already running rather than stopping because the balancer's own bookkeeping
  went bad.
