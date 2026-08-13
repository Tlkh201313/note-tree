# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The capture nudge recurs, instead of firing once.** It used to go silent for
  the rest of a session the moment a single note was saved — so a long session
  that saved one note early got no further reminders, however much note-worthy
  work followed. It now measures edits since this session *last saved a note*: a
  save (proactive or via `note_write`, both of which carry this session's id)
  resets the edit batch, and once enough new edits pile up past the cooldown it
  reminds again. A single early save can never deadlock it into silence, and a
  save from another project's session can no longer suppress this one's reminder.
- **The skill tells agents to save mid-session, not at the end.** The bundled
  note-tree skill now makes immediacy the rule — save the instant a durable fact
  clears the bar, while the reasoning is still in context — with end-of-session
  as an explicit backstop, not the plan. Batching to the end is how the one thing
  worth keeping gets forgotten.

### Added

- **One `/note-tree` command for everything (with a `/nt` alias).** The separate
  `/note`, `/tree`, and `/recall` slash commands are folded into a single command
  you run mid-session, shown with a `[save/read/sync/tree/status]` hint as you
  type: `save` (keep what's worth remembering), `read` (pull the relevant notes in
  *and* keep saving as you go), `sync` (rebuild the index after editing notes by
  hand), `tree` (open or print the tree), and `status` (is memory healthy?). Bare
  `/note-tree` — no action — gives a tight, token-lean nudge to lean on memory for
  the rest of the session rather than loading the whole skill; the skill's full bar
  still auto-loads exactly when you save. `/nt` is the short alias for the same
  thing.
- **The tree grows taller under a heavy project, not just more crowded.** A bay
  between two tiers used to be a fixed height whatever its branches carried, so a
  session that saved twenty notes piled them onto one stub. The bay height is now
  set by the busiest branch: a heavy session stretches the whole tree upward so
  its frond of leaves splays along a longer limb with room to breathe. A light
  history is unchanged — same height, same spacing — so only the trees that
  needed the room get it.
- **The tree ages.** A note nobody reads slowly withers — its leaf shrinks toward
  the floor of the size range and fades — and once it has been dormant past the
  fall threshold it drops on its own: auto-archived out of the session seed so it
  stops costing tokens, never deleted and always restorable. Recalls buy grace
  (a note you keep leaning on stays full-sized), and pinned notes and the
  high-value kinds (`gotcha`, `decision`) never wither or fall. Tunable — or
  frozen entirely — under a new `decay` config block; set `decay.enabled: false`
  to keep every leaf green forever.
- **Roots that match the codebase.** The root system now thickens, deepens and
  multiplies with the number of source files in the project on disk — a tree
  standing in a large repo looks more firmly anchored than one in an empty
  folder. The walk is cached and bounded, skips the noise (`.git`, dependencies,
  build output), and falls back to the note count where there's no project on
  disk, so exports and the hero are unchanged.

## [0.1.3] — 2026-08-13

### Added

- **Leaves grow by usefulness.** A leaf's size now reflects how much the note
  earns its place — its kind weight, how often it's been recalled, and whether
  it's pinned — so the notes worth reading are the biggest at a glance. The live
  server and export use your configured `ranking.kindWeights`.
- **A pin you can actually find.** The pinned mark is a gold four-point sparkle
  with a dark rim, read by its shape and its luminance rather than its hue, so a
  colour-blind eye catches it and it stays legible on any leaf colour beneath.

### Changed

- **The plant looks like a plant.** Branches and roots are filled tapering
  ribbons drawn in one bark ink — a limb swells at the stem and narrows to a
  point — instead of a few stroked rectangles. The growth replay reveals those
  filled limbs through the same clip sweep that grows the trunk.
- **Memory fills itself.** The Stop nudge now defaults to `agent` mode: after
  real edits with nothing saved, it asks the model to save the note itself
  (once per cooldown, with a one-line "nothing to save" out). Set
  `capture.nudgeMode: "user"` to get the old one-line reminder to yourself
  instead.

### Fixed

- Clicking a leaf no longer draws the browser's black focus box over the
  drawing; the accent ring is the focus cue.

## [0.1.2] — 2026-08-13

### Added

- **The tree follows the clock.** The page reads the local time on whatever
  machine opens it — light from 07:00, dark after 19:00, in the viewer's own
  timezone, with no geolocation and nothing to configure. The header toggle pins
  day or night, and a tree left open across sunset turns its own lights down.
- **The agent is told how to save, not just how to read.** The session seed
  carries a save hint phrased for whichever surface that agent has: MCP clients
  get `note_write`, everyone else gets the CLI form. It lives in the header, so
  it survives trimming to the smallest budget — the case where the tree is new
  and saving matters most.
- **`init` installs the skill.** The guide to what deserves a note shipped with
  the plugin but not with a plain `npm i -g note-tree`. It is now copied to
  `~/.claude/skills/note-tree/`, and `uninstall` removes it.
- Search in the tree page, filtering leaves and list together; a legend that
  mutes by kind; copy-as-markdown; and the seed cost in the header.

### Changed

- The tree page is quieter — flat stage, hairline ground, thinner strokes — and
  light mode is a warm cream (`#faf9f5` on `#3d3929`) rather than white. Both
  palettes are generated from one source into CSS variables, so switching
  recolours without a redraw.
- `ui.theme` was a dead config key nothing read. It now means `auto`, `day` or
  `night`, and sets what a fresh browser opens with.

### Fixed

- The secret redactor no longer eats variable references. A note explaining that
  CI writes `_authToken=${NODE_AUTH_TOKEN}` was scrubbed by our own redactor;
  `${VAR}`, `$VAR` and `%VAR%` are templates, not credentials. Real tokens are
  still redacted.

## [0.1.1] — 2026-08-12

No functional changes — `0.1.1` is byte-identical to `0.1.0` apart from the
version string. It exists because it is the first release published from CI,
so it is the first tarball to carry a **provenance attestation** linking it to
the commit and workflow that built it. `0.1.0` was published by hand and has
none.

### Changed

- Releases are cut by pushing a `v*` tag. The workflow runs the full suite on
  Linux and Windows, refuses to publish if the tag and `package.json` disagree,
  and authenticates to npm with OIDC — no publish token is stored in this
  repository.

## [0.1.0] — 2026-08-12

First release.

### Added

- **Store** — notes as plain files you can read, grep and hand-edit. Three
  drivers: `markdown` (default), `jsonl` append-log, and `json`. No database, no
  native modules, no install step.
- **Project and global memory** — project notes are shared across every session in
  that folder; global notes follow you into every project. `promote` moves a note
  up, `demote` moves it back.
- **Ranked, hard-capped session seed** — recency decay, kind weights, pin boost and
  read counts decide what fits the budget. Three verbosity presets (`minimal`,
  `medium`, `maximum`) set how much context a session gets.
- **Cross-CLI delivery in three tiers** — native session hooks (Claude Code, Codex,
  opencode), a marker-fenced generated block in `AGENTS.md` / Kiro steering /
  Cursor rules for everything else, and an MCP server with four tools plus
  `note_seed`. One store underneath all of them, so Claude and Codex in the same
  folder share memory.
- **Adapter registry** — Claude Code, Codex, opencode, Kiro, Gemini CLI, Cursor and
  a generic `AGENTS.md` fallback, each one declarative entry. `note-tree adapters`
  shows what's installed and which tier it gets.
- **The tree** — a deterministic SVG that grows with the project: time is height,
  a session is a branch, kind is colour. Live server with SSE, so a leaf sprouts
  the moment any agent saves a note, plus a self-contained HTML export.
- **CLI** — `init`, `sync`, `add`, `list`, `show`, `search`, `edit`, `promote`,
  `demote`, `pin`, `archive`, `restore`, `prune`, `tree`, `export`, `import`,
  `seed`, `status`, `doctor`, `demo`, `adapters`, `config`, `migrate`, `uninstall`.
- **Import** — `note-tree import` brings memory in from claude-mem (including a
  hand-rolled zero-dependency SQLite reader), `MEMORY.md`, `CLAUDE.md`, `AGENTS.md`
  or any JSON/JSONL export. `--dry-run` shows every note before anything is written.
- **Privacy defaults** — secrets are redacted on write, global notes stay out of a
  committed `AGENTS.md` unless you opt in, and there is no telemetry.

[Unreleased]: https://github.com/Tlkh201313/note-tree/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/Tlkh201313/note-tree/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Tlkh201313/note-tree/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Tlkh201313/note-tree/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Tlkh201313/note-tree/releases/tag/v0.1.0
