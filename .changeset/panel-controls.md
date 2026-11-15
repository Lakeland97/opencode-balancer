---
"@thelioo/opencode-balancer": patch
---

Make the panel's controls read as controls, and give a credential row two lines.

Every button is now enclosed — a `currentColor` border, a radius and padding — so
it reads as something to press rather than as a word that happens to react to a
click. Each dropdown sits in a frame of its own with a `▾` beside it, because the
host's native arrow is faint in this panel and the arrow is what says "a list
opens".

Section titles are fold controls too: clicking `models`, a brand header such as
`claude`, or a model's own label opens or closes it. The little chevron buttons
stay where they were, so a keyboard still has a real control to focus.

A credential row now has two lines. The first is who it is: the checkbox, the
name, and its markers. The second is what you can do to it: the refill the
endpoint named and the error it threw on the left, then a hairline, `free` and
`use`, and the reorder grip at the far right. Narrow windows used to produce
that shape only when the flow happened to wrap, and a parked credential's reason
was reachable only by hovering `limited`. It is now readable in place, cut to the
line with the full text on hover.

The panel is a built bundle, so a running window needs a reload to show it.
