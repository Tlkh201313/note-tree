<div align="center">

# 🌳 note-tree

**Memory that grows, not memory that bloats.**

Your agent's memory shouldn't cost 25 KB of context every session.
note-tree saves only what's worth remembering, injects a ranked and hard-capped
slice of it at session start, and shares it across **Claude Code, Codex,
opencode, Kiro, Cursor, Gemini CLI** — and anything that reads `AGENTS.md`.

Every note is a leaf on a tree that grows with your project.

<!-- Generated, never drawn: node scripts/hero.mjs — see docs/media.md -->
<img src="https://raw.githubusercontent.com/Tlkh201313/note-tree/main/docs/hero.svg" alt="A note-tree: 17 saved notes drawn as leaves, one branch per session, beside the ~517-token block a session actually receives" width="820">

**[▶ Play with a live tree →](https://tlkh201313.github.io/note-tree/)** — hover a leaf, click for the note, hit replay to watch it grow.

[![CI](https://github.com/Tlkh201313/note-tree/actions/workflows/ci.yml/badge.svg)](https://github.com/Tlkh201313/note-tree/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/note-tree.svg)](https://www.npmjs.com/package/note-tree)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

## The problem

Agent memory today comes in two shapes, and both leak tokens.

**A whole file, always loaded.** Claude Code's built-in memory keeps a
`MEMORY.md` capped at 200 lines / 25 KB — and loads *all* of it at session
start, relevant or not. It's per-project, and it doesn't follow you to another
tool.

**A whole session, compressed later.** Plugins in the `claude-mem` family
capture every tool call, compress each one through a model (spending your
tokens), keep a background worker alive, and inject the last N session summaries
plus dozens of observations into every session.

note-tree inverts the trade. **Save less, deliberately.** A note is written when
something durable was learned — a decision, a gotcha, a convention — and session
start injects a *ranked, budgeted* slice of those notes. Never a whole file,
never a daemon, never an API call.

## Numbers

Measured on this machine by [`test/bench.mjs`](test/bench.mjs) — Node v24,
Windows 11, a store of **1,000 notes**. Run it yourself; the methodology is at
the top of the file.

| measurement | note-tree |
| --- | --- |
| SessionStart, end to end | **81 ms** (p95 104 ms) |
| …of which is Node itself | 51 ms — note-tree adds **30 ms** |
| Injected per session | **~620 tokens** (21 notes, `medium`) |
| Resident processes | **none** |
| API calls to save a note | **zero** |
| MCP tool schemas | 5 tools, ~440 tokens |
| Search across 1,000 notes | 7 ms |
| Store size | 1.4 MB for 1,000 notes |
| Dependencies | **0** |

For scale: a `MEMORY.md` at its documented 25 KB cap is ~6,400 tokens **every
session**, about 11× the default seed — and it grows as your project does, while
the seed's ceiling doesn't move.

Tokens are estimated at 4 chars/token and applied identically to every row.
Numbers here are numbers we measured; nothing on this page is an unverifiable
vendor claim.

## Install

Requires Node ≥ 18. Nothing to compile, nothing to install alongside it.

```bash
npm install -g note-tree     # the CLI, for every agent
note-tree init               # detects your agent CLIs and wires each one
```

Claude Code users can install it as a plugin instead — same store, same CLI:

```
/plugin marketplace add Tlkh201313/note-tree
/plugin install note-tree
```

Curious first? This needs no setup at all and touches nothing:

```bash
npx note-tree demo           # grows a sample forest and opens it
```

Or [click a real tree in your browser](https://tlkh201313.github.io/note-tree/)
— it's the actual export, so every leaf hovers, opens and replays.

## Use it

Mostly you don't. The agent saves notes as it works, guided by the bundled
skill, and each new session starts with them already in context.

```bash
note-tree add "Pagination is cursor-based, never offset" --kind gotcha
note-tree list                  # ranked, the way a session sees them
note-tree search "auth"         # across this project and global memory
note-tree seed --dry-run        # the exact block a session receives, and its cost
note-tree tree                  # watch the tree, live, in your browser
note-tree promote <id>          # this belongs to every project, not just this one
note-tree doctor                # what's wired, what's wrong, how fast it is
```

The tree page is the point: leaves grow oldest-at-the-root, one branch per
session, colour by kind. Hover a leaf for its name and date, click for the full
note in a sidebar, and watch new leaves sprout live as any agent — in any
terminal — saves one.

It reads the clock on whatever machine opens it: paper by day, ink after dark,
in your own timezone with nothing to configure. The toggle in the header pins it
either way, or `note-tree config set ui.theme night` picks the starting point.

## Works with

One store, three delivery tiers. Every agent gets the best one it supports, and
`note-tree init` picks it for you.

| agent | memory arrives via | MCP tools | status |
| --- | --- | --- | --- |
| Claude Code | `SessionStart` hook (plugin or `--install-hooks`) | ✅ | supported |
| Codex CLI | `SessionStart` hook (v0.124+) | ✅ `~/.codex/config.toml` | supported |
| opencode | session plugin | ✅ | supported |
| Kiro | `.kiro/steering/note-tree.md` (`inclusion: auto`) | ✅ hot-reloads | supported |
| Gemini CLI | `GEMINI.md` block | ✅ | supported |
| Cursor | `.cursor/rules/note-tree.mdc` | ✅ | **experimental** — paths are community-documented, not first-party |
| AGENTS.md (Windsurf, Zed, Aider, Amp, goose, Copilot, Warp, Devin, …) | generated block in `AGENTS.md` | via each tool's own MCP config | supported |

- **Tier A — session hook.** The seed is rendered fresh every session. Zero idle
  cost: a process starts, prints, and exits.
- **Tier B — generated block.** For tools with no hook API, note-tree writes the
  same budgeted seed into the instructions file they already read, fenced with
  `<!-- note-tree:start -->` markers, and **rewrites it the moment any note
  changes** — so it can't go stale. Your own content is never touched, and
  removing note-tree leaves the file byte-identical to before.
- **Tier C — MCP.** Five terse tools (`note_write`, `note_read`, `note_search`,
  `note_manage`, `note_seed`) for any MCP client.

> **Privacy default:** the Tier B block contains **project-scope notes only**.
> `AGENTS.md` usually gets committed; your global notes stay in `~/.note-tree`
> unless you opt in per project with `contextFile.includeGlobal`.

Missing your tool? An adapter is [one declarative
object](src/agents/registry.mjs) — see
[CONTRIBUTING.md](CONTRIBUTING.md#adding-support-for-another-agent-cli).

## Where it lives

No database. Notes are plain files you can read, grep, hand-edit and commit.

```
~/.note-tree/
├─ config.json                 your settings
├─ index.json                  generated cache — the only file the hot path reads
├─ journal.jsonl               append-only event log (drives the live tree)
├─ global/notes/*.md           memory every project inherits
└─ projects/<slug>/notes/*.md  memory for one project
```

A note:

```markdown
---
id: a3f2k9
title: Seed injection is ranked and hard-capped
desc: SessionStart never exceeds budget; the ceiling is the 10k-char hook limit
kind: gotcha          # decision | convention | gotcha | architecture | preference | reference | todo
tags: [tokens, hooks]
scope: project
agent: claude         # which CLI learned this
created: 2026-08-12T19:59:00Z
---

Claude Code caps hook output at 10,000 characters. The seed renderer trims by
rank until it fits.
```

The project slug is derived from the working directory, so Claude Code and Codex
in the same folder resolve to the **same** project with no configuration. That's
the whole point: learn it once, in whichever tool you happened to be using.

Prefer a single append-only file? `note-tree config set storage.format jsonl`
(or `json`). Same notes, same behaviour.

## Configure

`~/.note-tree/config.json`, with optional per-project overrides. The one dial
most people touch is `verbosity`:

| preset | project notes | global notes | body cap | measured seed |
| --- | --- | --- | --- | --- |
| `minimal` | 8 | 3 | 60 words | ~280 tokens |
| `medium` *(default)* | 16 | 5 | 150 words | ~620 tokens |
| `maximum` | 30 | 8 | 400 words | ~1,600 tokens |

```bash
note-tree config set verbosity minimal        # or medium / maximum
note-tree config set budget.maxSeedChars 2000 # a hard ceiling, in characters
note-tree config set capture.stopNudge false  # stop reminding me to save notes
note-tree config list                         # everything, with its source
```

Also configurable: ranking (`halfLifeDays`, per-kind weights, pin boost),
dedupe threshold, redaction patterns, which agents are wired, UI port and theme,
and whether the journal is kept. Full reference: `note-tree help config`.

## What makes a good note

This is the part that decides whether memory is worth its tokens, so it ships as
a [skill](skills/note-tree/SKILL.md) the agent reads before saving. In short, a
note has to be **durable** (still true next month), **not re-derivable** (reading
the code wouldn't tell you), and **costly to rediscover**.

| ✅ worth a leaf | ❌ not |
| --- | --- |
| "The staging DB resets nightly at 03:00 UTC — don't debug data loss there" | "Fixed the login bug" |
| "We chose cursor pagination over offset because rows shift mid-scan" | "Added a function to `utils.ts`" |
| "`pnpm test` needs `--filter` here or it runs the whole monorepo" | Anything `git log` already says |

Near-duplicates are rejected on write (normalised title + trigram similarity), so
the tree stays signal-dense instead of growing twins.

## Migrating

Already have memory somewhere else? Bring it in — nothing is lost, and nothing is
written until you've seen it.

```bash
note-tree import --dry-run              # detects the source and shows every note
note-tree import --from claude-mem      # SQLite, JSON or JSONL — read-only
note-tree import --from memory-md       # Claude Code's MEMORY.md
note-tree import --from claude-md       # CLAUDE.md / AGENTS.md
```

Imported history is spread across branches by date, so a year of migrated notes
grows a real tree instead of one overloaded branch. Transcript-shaped records
are skipped on purpose — importing session logs would recreate the problem
note-tree exists to solve.

## Security and privacy

- **Notes are data, never instructions.** The seed is wrapped in a delimited
  block explicitly framed as recalled reference material, and note text can't
  close that fence.
- **Secrets are redacted on write**, and `privacy.denyPathPatterns` keeps
  `.env`-shaped content out of memory entirely.
- **No telemetry, no network.** The only socket note-tree ever opens is the
  local tree server, bound to `127.0.0.1`, which rejects non-loopback `Host`
  headers and cross-origin requests.
- **Zero dependencies** — nothing in your agent's memory path that we didn't
  write and you can't read.

Details and the full trust boundary: [SECURITY.md](SECURITY.md).

## Design decisions

**Fail open, always.** A memory plugin that breaks your session is worthless. If
anything goes wrong — corrupt index, unreadable store, malformed config — the
hook exits `0` and prints nothing. Worst case you lose memory for one session,
never the session. There are fault-injection tests for exactly this.

**No daemon, no `npx` on the hot path.** `npx` costs ~600 ms before running a
line of code. note-tree runs `node` directly against a small JSON index.

**No SQLite, no vector DB.** A thousand notes is not a database problem. Dropping
it is what makes zero dependencies, zero native modules and Node 18 support
possible at once.

**Ranked, not recent.** Pins first, then kind weight × exponential recency decay
× read count. Trimming to fit the budget drops the *lowest-ranked* notes, so what
survives is what earns its place.

## Development

No install step, because there's nothing to install.

```bash
git clone https://github.com/Tlkh201313/note-tree && cd note-tree
node test/run.mjs        # 739 assertions across 11 suites
node test/bench.mjs      # fails if SessionStart exceeds 150 ms at 1,000 notes
node bin/note-tree.mjs demo
```

CI runs the suite on Node 18/20/22/24 across Ubuntu, macOS and Windows, checks
that the dependency lists are still empty, and installs the packed tarball to
prove it runs with no `node_modules`.

## Roadmap

Documented, not built — in rough order:

- git-backed sync of the global tree across machines
- optional local embeddings for semantic search (still zero required deps)
- shared/team trees
- a VS Code extension for the tree view
- more agent adapters, as tools ship hook APIs

## Contributing

Adapters, especially. Adding a CLI is one object in the registry and a test row —
see [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports should include
`note-tree doctor`, which prints everything we'd otherwise have to ask for.

MIT © note-tree contributors.
