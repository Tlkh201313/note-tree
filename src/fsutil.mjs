/**
 * Small filesystem helpers shared by the stores, the index cache and the CLI.
 * Everything here is forgiving: a missing file is an empty result, not a throw.
 */

import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function readTextSafe(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export function readJson(file, fallback = null) {
  const raw = readTextSafe(file);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function listFiles(dir, ext = '.md') {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write via a temp file in the same directory, then rename.
 *
 * Rename is atomic on the same volume on every platform we support, so a reader
 * never observes a half-written file and a crash mid-write can't corrupt the
 * previous contents. This is what lets two agents write concurrently without a
 * lock file.
 */
export function atomicWrite(file, contents) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `fn(held)` while holding `<file>.lock`.
 *
 * Atomic writes stop a torn file, not a lost update: two agents that each
 * load-modify-save the same index both write back a list missing the other's
 * note. A lock older than `staleMs` belonged to a process that died holding it
 * (hooks exit hard on their watchdog), so it is broken rather than waited on.
 * Past `waitMs`, or where no lock can be created at all, `fn` runs with
 * `held = false` — a memory write must never hang a session.
 */
export function withLock(file, fn, { waitMs = 2000, staleMs = 2000 } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let held = false;
  ensureDir(path.dirname(lock));
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      held = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') break;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
        removeFile(lock);
        continue;
      }
    } catch {
      continue; // released between our open and our stat — try again
    }
    if (Date.now() >= deadline) break;
    Atomics.wait(SLEEP, 0, 0, 10);
  }
  try {
    return fn(held);
  } finally {
    if (held) removeFile(lock);
  }
}

export function writeJson(file, value) {
  return atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a file to `<root>/backups/<name>.<stamp>.bak` before we edit it.
 *
 * A missing `backupsDir` means "don't keep one" — a caller that opted out of
 * backups still expects its edit to go through, not to crash on the safety net.
 */
export function backupFile(file, backupsDir) {
  if (!exists(file) || !backupsDir) return null;
  ensureDir(backupsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `${path.basename(file)}.${stamp}.bak`);
  try {
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/** Filesystem-safe fragment of a title, used in note filenames. */
export function slugify(s, max = 40) {
  return (
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'note'
  );
}
