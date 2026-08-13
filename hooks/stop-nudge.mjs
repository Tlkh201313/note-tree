#!/usr/bin/env node
/**
 * Stop — the capture nudge.
 *
 * The failure mode of every memory tool is the same: nobody remembers to save
 * anything, so the memory stays empty and the tool looks useless. This is the
 * fix, and it is pure JavaScript — no LLM call, no API cost, no latency.
 *
 * It fires only when the session actually changed files and saved no notes, at
 * most once per cooldown, and by default it speaks to *you*, not to the model.
 *
 * Usage: node stop-nudge.mjs [--agent claude]
 */

import { run, arg, readStdinJson, resolveCwd, resolveSession } from './lib.mjs';
import { loadConfig } from '../src/config.mjs';
import { projectSlug } from '../src/paths.mjs';
import { loadIndex } from '../src/index-cache.mjs';
import { stopEnvelope } from '../src/agents/envelopes.mjs';
import { readState, writeState, startSession, countNewEdits } from '../src/session-state.mjs';
import { decayConfig, hasFallen } from '../src/decay.mjs';
import { openContext } from '../src/context.mjs';

const agent = String(arg('agent', 'claude'));

await run(async () => {
  const payload = await readStdinJson(200);

  // If our own nudge is what resumed this turn, stay quiet. Never loop.
  if (payload?.stop_hook_active) return '';

  const sessionId = resolveSession(payload);
  if (!sessionId) return '';

  const cwd = resolveCwd(payload);
  const slug = projectSlug(cwd);
  const cfg = loadConfig({ slug });

  // A leaf nobody has read in months falls on its own — the tree sheds its own
  // dead weight so the seed keeps costing tokens only for what still matters.
  // Independent of the capture nudge below, so it runs even when that's off.
  try {
    retireFallen(cfg, { cwd, slug, sessionId });
  } catch {
    /* decay is a nicety; a Stop hook must never fail because of it */
  }

  if (cfg.capture?.stopNudge === false) return '';

  const p = cfg.paths;
  const state =
    readState(p, sessionId) ||
    startSession(p, {
      sessionId,
      agent,
      cwd,
      slug,
      transcript: payload?.transcript_path || null,
    });

  const transcript = payload?.transcript_path || state.transcript || null;
  const { edits, cursor } = countNewEdits(transcript, state.cursor || 0);

  const next = {
    ...state,
    transcript,
    cursor,
    edits: (state.edits || 0) + edits,
    turns: (state.turns || 0) + 1,
  };

  const threshold = cfg.capture?.nudgeAfterEdits ?? 3;
  const cooldownMs = (cfg.capture?.nudgeCooldownMin ?? 30) * 60_000;
  const sinceNudge = next.lastNudge ? Date.now() - Date.parse(next.lastNudge) : Infinity;

  // Did this session already record something? Then it doesn't need reminding.
  // Counted by time as well as by session id, because a note saved through the
  // MCP tool or the CLI carries a different session id than this hook sees.
  const saved = countRecentNotes(p, sessionId, next.started);

  const shouldNudge = next.edits >= threshold && saved === 0 && sinceNudge >= cooldownMs;
  if (shouldNudge) next.lastNudge = new Date().toISOString();
  writeState(p, sessionId, next);
  if (!shouldNudge) return '';

  const mode = cfg.capture?.nudgeMode === 'agent' ? 'agent' : 'user';
  const message =
    mode === 'agent'
      ? `This session changed ${next.edits} file${next.edits === 1 ? '' : 's'} and saved no memory. If anything durable was decided or discovered — a decision, a convention, a gotcha that cost time — save one short note with note_write now. If nothing here is worth remembering next session, say so in one line and stop.`
      : `note-tree: ${next.edits} file edits, no notes saved. Worth remembering anything? Ask for a note, or run: note-tree add`;

  return stopEnvelope(agent, { message, mode });
});

/**
 * Auto-archive leaves that have gone dormant past the fall threshold.
 *
 * The cheap path — a healthy tree — is a filter over the two indexes that are
 * already on disk; nothing is opened for writing unless something is actually
 * due. Pinned notes and protected kinds never fall (see `hasFallen`). Bounded,
 * so one very old tree can't turn a Stop hook into a long archive run.
 */
function retireFallen(cfg, { cwd, slug, sessionId }) {
  const d = decayConfig(cfg);
  if (!d.enabled) return;

  const now = Date.now();
  const due = [];
  for (const scope of ['project', 'global']) {
    try {
      for (const note of loadIndex(cfg.paths, scope).notes) {
        if (!note.archived && hasFallen(note, d, now)) due.push(note.id);
        if (due.length >= 25) break;
      }
    } catch {
      /* a missing index just means that scope has nothing to shed */
    }
    if (due.length >= 25) break;
  }
  if (!due.length) return;

  const ctx = openContext({ cwd, slug, agent, session: sessionId });
  for (const id of due) {
    try {
      ctx.store.archive(id);
    } catch {
      /* one stubborn note shouldn't stop the rest from falling */
    }
  }
}

function countRecentNotes(p, sessionId, startedIso) {
  const since = Date.parse(startedIso || '') || 0;
  let n = 0;
  for (const scope of ['project', 'global']) {
    try {
      for (const note of loadIndex(p, scope).notes) {
        if (note.session === sessionId) n++;
        else if (since && Date.parse(note.created || '') >= since) n++;
      }
    } catch {
      /* a missing index just means nothing was saved */
    }
  }
  return n;
}
