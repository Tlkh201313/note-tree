---
description: Open the note-tree memory tree in a browser, or print it in the terminal
argument-hint: [--plain | --global]
allowed-tools: Bash(note-tree:*), Bash(node:*)
---

Show the memory tree for this project.

Run the note-tree CLI with the arguments `tree $ARGUMENTS`, preferring the global
`note-tree` binary and falling back to `node "${CLAUDE_PLUGIN_ROOT}/bin/note-tree.mjs"`
if it isn't on PATH.

Two things matter here:

- **`--plain` prints an ASCII tree and exits.** Use it whenever the user asked for
  the tree in the terminal, or when no browser is available.
- **Without `--plain` the command starts a local server and does not return.** Run
  it in the background, wait for the URL it prints, and report that URL. Do not
  wait for the process to exit — it won't, and the tree stays live so a leaf
  sprouts the moment any agent saves a note.

Report the URL (or the ASCII tree) and the note count. Nothing else.
