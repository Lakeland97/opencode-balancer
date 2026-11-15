---
"@thelioo/opencode-balancer": patch
---

Reorder by dragging, instead of with `↑`/`↓` buttons.

The credential rows and a row's targets each carried a pair of step buttons. Each
row now has one grip in a right-hand gutter — the same place on every row, and out
of the flow so a wrapping label cannot push it around: drag it onto the row whose
place it should take, and it moves all the way there in one gesture.

Nothing about the order changed. Credentials are still one flat list in the order
requests take them, a row's targets are still an ordered list of their own, and a
drop names the slot it landed on rather than a direction. With the grip focused,
the arrow keys still move the row one place, so reordering does not require a
mouse.

The panel is a rebuilt bundle, so the running window needs a reload to show it.
