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
  claude: 'note_write, or run: note-tree add "…" --kind <kind>',
  codex: 'note_write, or run: note-tree add "…" --kind <kind>',
  opencode: 'note_write, or run: note-tree add "…" --kind <kind>',
}[agent] || 'note-tree add "…" --kind <kind>';

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
    let state = null;
    if (sessionId) {
      try {
        state = startSession(cfg.paths, {
          sessionId,
          agent,
          cwd,
          slug,
          source: payload?.source || null,
          transcript: payload?.transcript_path || null,
          injected: seed?.ids?.slice(0, 30),
        });
        pruneSessions(cfg.paths);
      } catch {
        /* ignore */
      }
    }

    // Compaction drops what the agent knew it hadn't saved yet; say so in one line.
    const unsaved = state?.batch ? state.batch.files.length + state.batch.anon : 0;
    const carry = payload?.source === 'compact' && unsaved > 0
      ? `note-tree: ${unsaved} file${unsaved === 1 ? '' : 's'} changed before this compaction with no note saved — save one if anything is worth remembering.`
      : '';

    const text = [seed?.text, carry].filter(Boolean).join('\n');
    if (!text) return ''; // an empty tree costs exactly zero tokens
    const mode = modeArg || cfg.hooks?.injectionMode || 'auto';
    return sessionStartEnvelope(agent, text, mode);
  },
  { watchdogMs: Number(process.env.NOTE_TREE_WATCHDOG_MS) || 400 },
);
