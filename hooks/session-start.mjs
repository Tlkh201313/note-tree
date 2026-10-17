#!/usr/bin/env node
/**
 * SessionStart — the only code note-tree runs on every single session.
 *
 * Budget: two small JSON reads (and AGENTS.md), two `stat`s, one render, one
 * write to stdout.
 * No daemon, no port, no API call, no `npm install`, no note files opened.
 *
 * Usage: node session-start.mjs [--agent claude|codex|opencode] [--mode auto|json|text]
 */

import { run, arg, readStdinJson, resolveCwd, resolveSession } from './lib.mjs';
import { recall } from '../src/recall.mjs';
import { sessionStartEnvelope } from '../src/agents/envelopes.mjs';
import { startSession, pruneSessions } from '../src/session-state.mjs';

const agent = String(arg('agent', 'claude'));
const modeArg = arg('mode', null);

/** How this agent fetches a full note — shown once in the seed header. */
const RECALL_HINT = {
  claude: 'note_read(id)',
  codex: 'note_read(id)',
  opencode: 'note_read(id)',
}[agent] || 'note-tree show <id>';

/**
 * How this agent saves one. Both forms are offered on purpose: the MCP tools
 * only exist once the client has connected (and, in Claude Code, once the user
 * has approved the server), while the CLI is always there. An agent that can't
 * find `note_write` should still know it can shell out.
 */
const SAVE_HINT = {
  claude: 'note_write, or run: note-tree add "…" --kind gotcha',
  codex: 'note_write, or run: note-tree add "…" --kind gotcha',
  opencode: 'note_write, or run: note-tree add "…" --kind gotcha',
}[agent] || 'note-tree add "…" --kind gotcha';

const SEARCH_HINT = { claude: 'note_search', codex: 'note_search', opencode: 'note_search' }[agent] || 'note-tree search "…"';

/**
 * These agents also load the project's AGENTS.md, where note-tree keeps a block
 * for tools with no hook. Notes it already lists aren't injected a second time.
 */
const CONTEXT_FILE = { claude: 'AGENTS.md', codex: 'AGENTS.md', opencode: 'AGENTS.md' }[agent] || null;

await run(
  async () => {
    const payload = await readStdinJson(200);
    const cwd = resolveCwd(payload);
    const sessionId = resolveSession(payload);

    const { cfg, slug, seed } = await recall({
      cwd,
      recallHint: RECALL_HINT,
      saveHint: SAVE_HINT,
      searchHint: SEARCH_HINT,
      contextFile: CONTEXT_FILE,
    });

    // Record the session so the Stop nudge has something to compare against.
    // Best-effort: this must never delay or fail the injection.
    if (sessionId) {
      try {
        startSession(cfg.paths, {
          sessionId,
          agent,
          cwd,
          slug,
          source: payload?.source || null,
          transcript: payload?.transcript_path || null,
        });
        pruneSessions(cfg.paths);
      } catch {
        /* ignore */
      }
    }

    if (!seed) return ''; // an empty tree costs exactly zero tokens
    const mode = modeArg || cfg.hooks?.injectionMode || 'auto';
    return sessionStartEnvelope(agent, seed.text, mode);
  },
  { watchdogMs: Number(process.env.NOTE_TREE_WATCHDOG_MS) || 400 },
);
