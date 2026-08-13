# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Tlkh201313/note-tree/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Tlkh201313/note-tree/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Tlkh201313/note-tree/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Tlkh201313/note-tree/releases/tag/v0.1.0
