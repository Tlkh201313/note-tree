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

/** SessionStart sources that carry earlier history in the transcript. */
const INHERITS = new Set(['resume', 'clear', 'compact', 'fork']);

/**
 * Begin (or rejoin) a session's scratch state.
 *
 * Compaction fires SessionStart again under the same session id, so a state
 * that already exists is kept — its cursor, batch and nudge pacing — and only
 * its labels are refreshed; resetting it re-counted the whole history. A fresh
 * state on a resumed/cleared/compacted/forked session starts its cursor at the
 * transcript's current size, so inherited edits are never counted as new work.
 */
export function startSession(p, { sessionId, agent, cwd, slug, source, transcript, injected }) {
  const prev = source === 'startup' ? null : readState(p, sessionId);
  if (prev) {
    const state = {
      ...prev,
      agent: agent || prev.agent,
      cwd: cwd || prev.cwd,
      slug: slug || prev.slug,
      source: source || prev.source,
      transcript: transcript || prev.transcript,
      injected: injected || prev.injected,
    };
    writeState(p, sessionId, state);
    return state;
  }
  let cursor = 0;
  if (INHERITS.has(source) && transcript) {
    try { cursor = fs.statSync(transcript).size; } catch { /* no transcript yet */ }
  }
  const state = {
    sid: safeId(sessionId),
    agent: agent || null,
    cwd: cwd || null,
    slug: slug || null,
    source: source || null,
    transcript: transcript || null,
    started: new Date().toISOString(),
    cursor,
    edits: 0,
    turns: 0,
    lastNudge: null,
    injected: injected || [],
  };
  writeState(p, sessionId, state);
  return state;
}

/** Tool names that mean "the working tree changed" — the signal worth a note. */
const EDIT_MARKERS = [
  '"name":"Edit"', '"name":"Write"', '"name":"MultiEdit"', '"name":"NotebookEdit"',
  '"name": "Edit"', '"name": "Write"', '"name": "MultiEdit"', '"name": "NotebookEdit"',
];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Where the project starts: the nearest `.git` above `cwd`, so a hook that fires from a subfolder still sees the whole repo. */
function projectRoot(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(cwd);
}

function isInside(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Which files the agent edited since we last looked.
 *
 * Counting `"name":"Edit"` substrings over-counted badly: one file edited five
 * times was five, and newer transcripts embed the same tool_use again inside
 * request-snapshot records (3 of every 5 hits in a real session). So only
 * `assistant` records are read, each tool_use is counted once by id, a file is one
 * file however often it changes, edits the tool reported as failed are dropped,
 * and anything outside the project (a plan file, a scratch script) is not
 * project work. A tool_use with no path still counts, once.
 *
 * Reads the new bytes only, bounded to 2 MB, and advances the cursor to the last
 * complete line so a record still being written is read next time, not half now.
 *
 * shortcut: an edit that fails in a *later* scan is already counted, and changes
 * made through Bash are never seen; upgrade if `note-tree stats` shows nudges
 * firing on sessions that saved real work.
 *
 * @returns {{ files: string[], anon: number, cursor: number }}
 */
export function countNewEdits(transcript, cursor = 0, { cwd = null } = {}) {
  if (!transcript) return { files: [], anon: 0, cursor };
  let fd;
  try {
    const size = fs.statSync(transcript).size;
    if (size <= cursor) return { files: [], anon: 0, cursor: size }; // truncated or unchanged

    const start = Math.max(cursor, size - 2 * 1024 * 1024);
    fd = fs.openSync(transcript, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);

    const end = buf.lastIndexOf(10) + 1; // through the last complete line
    if (!end) return { files: [], anon: 0, cursor }; // one line, still being written
    let lines = buf.subarray(0, end).toString('utf8').split('\n');
    if (start > cursor) lines = lines.slice(1); // the window opened mid-record

    const root = cwd ? projectRoot(cwd) : null;
    const edits = []; // { id, file }
    const failed = new Set();
    let parsedAny = false;
    let markers = 0;
    for (const line of lines) {
      const hasEdit = EDIT_MARKERS.some((m) => line.includes(m));
      // Failed results are rare; matching only `true` keeps this from parsing every tool output.
      if (!hasEdit && !line.includes('"is_error":true') && !line.includes('"is_error": true')) continue;
      if (hasEdit) markers++;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      parsedAny = true;
      const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
      if (rec.type === 'assistant') {
        for (const b of blocks) {
          if (b?.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
            edits.push({ id: b.id || null, file: b.input?.file_path || b.input?.notebook_path || null });
          }
        }
      } else if (rec.type === 'user') {
        for (const b of blocks) if (b?.type === 'tool_result' && b.is_error && b.tool_use_id) failed.add(b.tool_use_id);
      }
    }

    // Nothing parsed at all means a format we don't know, not "no edits":
    // fall back to the old count rather than let the nudge go silent for good.
    if (!parsedAny && markers) return { files: [], anon: markers, cursor: start + end };

    const files = new Set();
    const seen = new Set();
    let anon = 0;
    for (const e of edits) {
      if (e.id) {
        if (seen.has(e.id) || failed.has(e.id)) continue;
        seen.add(e.id);
      }
      if (!e.file) anon++;
      else if (!root || isInside(root, e.file)) files.add(path.resolve(e.file));
    }
    return { files: [...files], anon, cursor: start + end };
  } catch {
    return { files: [], anon: 0, cursor };
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
