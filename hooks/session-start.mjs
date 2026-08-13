#!/usr/bin/env node
/**
 * SessionStart — the only code note-tree runs on every single session.
 *
 * Budget: two small JSON reads, two `stat`s, one render, one write to stdout.
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

await run(
  async () => {
    const payload = await readStdinJson(200);
    const cwd = resolveCwd(payload);
    const sessionId = resolveSession(payload);

    const { cfg, slug, seed } = await recall({ cwd, recallHint: RECALL_HINT, saveHint: SAVE_HINT });

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
