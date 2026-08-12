/**
 * Append-only event log.
 *
 * Every mutation appends one line. The web UI tails this file to sprout leaves
 * live, `sync` uses it to reconcile, and it doubles as an audit trail of which
 * agent learned what.
 *
 * Appends are single `appendFileSync` calls with the `a` flag, which is atomic
 * for writes below the pipe-buffer size on every platform we target — that is
 * what makes two agents writing at once safe without a lock file.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Rotate once the log passes this size, so it can never grow without bound. */
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_ROTATIONS = 2;

/**
 * Append one event. Never throws — losing a journal line must not fail a write
 * that already landed on disk.
 */
export function append(journalFile, event) {
  if (!journalFile) return false;
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n';
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    rotateIfNeeded(journalFile, line.length);
    fs.appendFileSync(journalFile, line);
    return true;
  } catch {
    return false;
  }
}

function rotateIfNeeded(file, incoming) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size + incoming <= MAX_BYTES) return;
  try {
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* rotation is best-effort */
  }
}

/** Parse every readable line, skipping anything corrupt. Never throws. */
export function readAll(journalFile) {
  let raw;
  try {
    raw = fs.readFileSync(journalFile, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn final line is expected while another process is appending */
    }
  }
  return out;
}

/**
 * Read the last `n` events without loading the whole file.
 * Reads a trailing window and grows it until enough complete lines are found.
 */
export function tail(journalFile, n = 50) {
  let fd, size;
  try {
    fd = fs.openSync(journalFile, 'r');
    size = fs.fstatSync(fd).size;
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    return [];
  }

  try {
    let window = Math.min(size, Math.max(8192, n * 256));
    let text = '';
    for (;;) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      // Drop a partial first line unless we're at the very start of the file.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length >= n || start === 0) {
        const out = [];
        for (const line of lines.slice(-n)) {
          try { out.push(JSON.parse(line)); } catch { /* skip */ }
        }
        return out;
      }
      window = Math.min(size, window * 4);
    }
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Byte offset of the end of the log — the cursor the UI resumes from. */
export function size(journalFile) {
  try {
    return fs.statSync(journalFile).size;
  } catch {
    return 0;
  }
}

/**
 * Read complete events appended after `from`, returning the new cursor.
 * A trailing partial line is left for the next poll rather than dropped.
 */
export function since(journalFile, from = 0) {
  const end = size(journalFile);
  if (end <= from) return { events: [], cursor: end };

  let fd;
  try {
    fd = fs.openSync(journalFile, 'r');
    const buf = Buffer.alloc(end - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { events: [], cursor: from };

    const events = [];
    for (const line of text.slice(0, lastNl).split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return { events, cursor: from + Buffer.byteLength(text.slice(0, lastNl + 1)) };
  } catch {
    return { events: [], cursor: from };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Convenience wrapper used by every mutation site. */
export function logNote(journalFile, ev, note, extra = {}) {
  return append(journalFile, {
    ev,
    id: note.id,
    scope: note.scope,
    project: note.project ?? null,
    kind: note.kind,
    title: note.title,
    agent: note.agent ?? null,
    session: note.session ?? null,
    ...extra,
  });
}
