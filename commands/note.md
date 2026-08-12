---
description: Save what's worth remembering from this session as a note-tree memory
argument-hint: [what to remember, or nothing to let Claude pick]
---

Save a durable memory with the `note_write` tool.

$ARGUMENTS

If nothing is specified above, look back over this session and find what a future
session would genuinely need: a decision and its reasoning, a gotcha that cost
time, a convention, a stable architectural fact, or a preference the user stated.

Apply the bar from the **note-tree** skill before writing:

- Durable — still true next month.
- Not re-derivable — a teammate couldn't learn it in ten seconds from the obvious file.
- Cost someone something to discover.

Then:

1. Check the memory already in context, and `note_search` for anything close.
   If the fact exists, `note_write` with that `id` to improve it instead of adding a twin.
2. Write a title that states the claim itself, not the topic.
3. Write a body of about 150 words: the fact, why it's true, and what it costs to
   get wrong.
4. Pick the `kind`, and set `scope: "global"` only if it is true in every project.

If nothing in this session clears the bar, say so plainly and save nothing — that
is the correct outcome more often than not.

Report each saved note as `id · title`, and nothing else.
