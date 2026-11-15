---
"@thelioo/opencode-balancer": patch
---

Hold the compaction reserve to a floor: the size of the summary prompt itself.

Compacting sends the conversation **plus** a summarization instruction, and the
buffer is the room reserved for that request. A very small buffer — `1%` on a
small model — could reserve less than the instruction the request carries,
leaving the summary request itself over the window it was meant to stay under: the
same overflow, reached from the other side. A reserve below that size is now
raised to it, so the cut lands slightly earlier exactly where it has to.

The size is measured rather than assumed. The balancer sees the compaction request
go past, reads the instruction the host appended, rounds it to the nearest
thousand, and remembers it, so the floor follows the host if its prompt ever
changes; the host's short retry reminder is ignored so it cannot overwrite a real
measurement. Until the first compaction has been watched the figure stands at what
the host's own prompt measured when this was written.

Nothing in the panel changes: the context limit and the buffer are shown as typed,
and the floor only moves the trigger.
