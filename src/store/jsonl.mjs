/**
 * JSONL driver — one append-only log per scope.
 *
 * Writes are a single `appendFileSync`, so saving a note is one syscall and
 * concurrent writers interleave safely instead of racing on a shared file. The
 * last line for an id wins; deletions are tombstones. The log is compacted once
 * it accumulates more dead lines than live notes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeNote } from '../note.mjs';
import { ensureDir, readTextSafe, atomicWrite } from '../fsutil.mjs';

export const format = 'jsonl';

const COMPACT_MIN_LINES = 200;
const COMPACT_RATIO = 2;

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

export function createDriver(p) {
  const fileFor = (scope) => (scope === 'global' ? p.globalStore : p.projectStore);

  /** Replay the log into a live map, newest line per id winning. */
  function load(scope) {
    const file = fileFor(scope);
    if (!file) return { map: new Map(), lines: 0, file };
    const raw = readTextSafe(file);
    if (raw === null) return { map: new Map(), lines: 0, file };

    const map = new Map();
    let lines = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a torn line from a concurrent append; the next write supersedes it
      }
      if (!rec || !rec.id) continue;
      if (rec._deleted) map.delete(rec.id);
      else map.set(rec.id, rec);
    }
    return { map, lines, file };
  }

  function hydrate(rec, scope, file) {
    try {
      const note = makeNote({ ...rec, scope }, { scope });
      note.id = rec.id;
      return { ...note, file: rel(p.root, file) };
    } catch {
      return null;
    }
  }

  function compactIfNeeded(scope, map, lines, file) {
    if (lines < COMPACT_MIN_LINES || lines < map.size * COMPACT_RATIO) return;
    try {
      const body = [...map.values()].map((r) => JSON.stringify(r)).join('\n') + '\n';
      atomicWrite(file, body);
    } catch {
      /* compaction is an optimisation, never a correctness requirement */
    }
  }

  return {
    format,

    ensure(scope) {
      const file = fileFor(scope);
      if (file) ensureDir(path.dirname(file));
      return file;
    },

    all(scope) {
      const { map, lines, file } = load(scope);
      if (!file) return [];
      compactIfNeeded(scope, map, lines, file);
      const out = [];
      for (const rec of map.values()) {
        const note = hydrate(rec, scope, file);
        if (note) out.push(note);
      }
      return out;
    },

    get(scope, id) {
      const { map, file } = load(scope);
      const rec = map.get(id);
      return rec ? hydrate(rec, scope, file) : null;
    },

    put(note) {
      const file = fileFor(note.scope);
      ensureDir(path.dirname(file));
      const { file: _drop, ...clean } = note;
      fs.appendFileSync(file, JSON.stringify(clean) + '\n');
      return { note: { ...clean, file: rel(p.root, file) }, file };
    },

    del(scope, id) {
      const file = fileFor(scope);
      if (!file) return false;
      try {
        ensureDir(path.dirname(file));
        fs.appendFileSync(file, JSON.stringify({ id, _deleted: true }) + '\n');
        return true;
      } catch {
        return false;
      }
    },
  };
}
