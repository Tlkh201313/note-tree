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

  // The nudge measures edits made since this session last saved a note — not since
  // the session began — so it keeps firing through a long session instead of going
  // quiet forever the moment one note lands. Every run scans for notes this session
  // saved since the previous scan (`lastSaveCheck`); when one turns up, the edit
  // baseline jumps to now, so only work done *after* that save counts toward the
  // next reminder. The scan is scoped to this session's own id (the MCP server
  // adopts it — proactive and tool saves both carry it) AND time-bounded, and it is
  // that pairing that keeps a single early save from deadlocking the nudge into
  // silence while stopping a concurrent save in another project from suppressing it.
  const savedSince = countSessionNotes(p, sessionId, next.lastSaveCheck);
  next.lastSaveCheck = new Date().toISOString();
  if (savedSince > 0) next.savedEditCursor = next.edits; // this batch is remembered

  // Edits piled up since the last save the agent still hasn't committed to memory.
  // The cooldown — not a moving baseline — is what paces repeat reminders, so this
  // count keeps climbing until something is saved and the message stays truthful.
  const editsSinceSaved = next.edits - (next.savedEditCursor || 0);
  const shouldNudge = editsSinceSaved >= threshold && sinceNudge >= cooldownMs;
  if (shouldNudge) next.lastNudge = new Date().toISOString(); // pace the next reminder
  writeState(p, sessionId, next);
  if (!shouldNudge) return '';

  const mode = cfg.capture?.nudgeMode === 'agent' ? 'agent' : 'user';
  const files = `${editsSinceSaved} file${editsSinceSaved === 1 ? '' : 's'}`;
  const message =
    mode === 'agent'
      ? `This session has changed ${files} since anything was saved to memory. If a decision, convention, or gotcha that cost time came out of that work, save one short note with note_write now — while it's still in context. If nothing there is worth remembering next session, say so in one line and stop.`
      : `note-tree: ${files} changed since the last saved note. Worth remembering anything? Ask for a note, or run: note-tree add`;

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

/**
 * Count notes THIS session saved with `created` at or after `since`.
 *
 * Scoped to the session's own id, so a concurrent save in another project — which
 * shares the one global index — can never be mistaken for this session remembering
 * something. Time-bounded, so a save early in the session stops counting once the
 * nudge has advanced its `lastSaveCheck` past it. With no bound yet (the first run
 * of a session), `since` is 0 and any note this session has already saved counts —
 * that's how a note written before the first Stop still silences the first nudge.
 */
function countSessionNotes(p, sessionId, sinceIso) {
  const since = Date.parse(sinceIso || '') || 0;
  let n = 0;
  for (const scope of ['project', 'global']) {
    try {
      for (const note of loadIndex(p, scope).notes) {
        if (note.session === sessionId && (Date.parse(note.created || '') || 0) >= since) n++;
      }
    } catch {
      /* a missing index just means nothing was saved */
    }
  }
  return n;
}
