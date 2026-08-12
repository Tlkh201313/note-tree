/**
 * Per-session scratch state.
 *
 * Small, disposable, and never read on the session-start hot path. It exists so
 * the Stop nudge can tell "you changed a lot and saved nothing" from "you
 * answered one question", without a background process watching anything.
 *
 * The interesting trick is `cursor`: instead of re-reading the whole transcript
 * on every turn, we remember how far we'd read and only scan the new bytes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, atomicWrite } from './fsutil.mjs';

const MAX_AGE_MS = 7 * 86_400_000;

/** Session ids come from other tools, so never let one escape into a path. */
function safeId(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';
}

export function stateFile(p, sessionId) {
  return path.join(p.sessions, `${safeId(sessionId)}.json`);
}

export function readState(p, sessionId) {
  return readJson(stateFile(p, sessionId), null);
}

export function writeState(p, sessionId, state) {
  try {
    ensureDir(p.sessions);
    atomicWrite(stateFile(p, sessionId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function startSession(p, { sessionId, agent, cwd, slug, source, transcript }) {
  const state = {
    sid: safeId(sessionId),
    agent: agent || null,
    cwd: cwd || null,
    slug: slug || null,
    source: source || null,
    transcript: transcript || null,
    started: new Date().toISOString(),
    cursor: 0,
    edits: 0,
    turns: 0,
    lastNudge: null,
  };
  writeState(p, sessionId, state);
  return state;
}

/** Tool names that mean "the working tree changed" — the signal worth a note. */
const EDIT_MARKERS = [
  '"name":"Edit"', '"name":"Write"', '"name":"MultiEdit"', '"name":"NotebookEdit"',
  '"name": "Edit"', '"name": "Write"', '"name": "MultiEdit"', '"name": "NotebookEdit"',
];

/**
 * Count edit tool calls appended to the transcript since we last looked.
 *
 * Deliberately a substring scan, not a JSON parse: transcripts are large,
 * append-only JSONL, and we only need a count. Bounded to 2 MB per turn so a
 * pathological transcript can't stall the hook.
 */
export function countNewEdits(transcript, cursor = 0) {
  if (!transcript) return { edits: 0, cursor };
  let fd;
  try {
    const size = fs.statSync(transcript).size;
    if (size <= cursor) return { edits: 0, cursor: size }; // truncated or unchanged

    const start = Math.max(cursor, size - 2 * 1024 * 1024);
    fd = fs.openSync(transcript, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');

    let edits = 0;
    for (const marker of EDIT_MARKERS) {
      let i = text.indexOf(marker);
      while (i !== -1) {
        edits++;
        i = text.indexOf(marker, i + marker.length);
      }
    }
    return { edits, cursor: size };
  } catch {
    return { edits: 0, cursor };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Find the session this process most likely belongs to.
 *
 * An MCP server is spawned by the agent moments after its SessionStart hook
 * ran, but is never told the session id. Adopting the newest recent session for
 * the same working directory keeps notes written through the tools on the same
 * branch of the tree as the session that produced them — and lets the Stop
 * nudge see that a note was in fact saved.
 */
export function adoptSession(p, cwd, maxAgeMs = 12 * 3600_000) {
  let best = null;
  try {
    const target = cwd ? path.resolve(cwd).toLowerCase() : null;
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(p.sessions)) {
      const file = path.join(p.sessions, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) continue;
        const state = readJson(file, null);
        if (!state?.sid) continue;
        if (target && state.cwd && path.resolve(state.cwd).toLowerCase() !== target) continue;
        if (!best || stat.mtimeMs > best.mtime) best = { sid: state.sid, mtime: stat.mtimeMs };
      } catch {
        /* skip unreadable state */
      }
    }
  } catch {
    /* no sessions directory yet */
  }
  return best?.sid || null;
}

export function endSession(p, sessionId) {
  try {
    fs.unlinkSync(stateFile(p, sessionId));
  } catch {
    /* already gone */
  }
}

/** Drop state files from sessions that ended without telling us. */
export function pruneSessions(p, maxAgeMs = MAX_AGE_MS) {
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(p.sessions)) {
      const file = path.join(p.sessions, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no sessions dir yet */
  }
  return removed;
}
