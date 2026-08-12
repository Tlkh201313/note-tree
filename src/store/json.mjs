/**
 * JSON driver — one `notes.json` array per scope.
 *
 * The simplest thing to inspect or hand-edit, and the easiest to ship somewhere
 * else. Every write is read-modify-write behind an atomic rename, so a crash
 * can't corrupt the file — but two simultaneous writers can lose one update,
 * which is why `markdown` (a file per note) remains the default.
 */

import path from 'node:path';
import { makeNote } from '../note.mjs';
import { ensureDir, readJson, atomicWrite } from '../fsutil.mjs';

export const format = 'json';

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

export function createDriver(p) {
  const fileFor = (scope) =>
    scope === 'global'
      ? p.globalDir && path.join(p.globalDir, 'notes.json')
      : p.projectDir && path.join(p.projectDir, 'notes.json');

  function load(scope) {
    const file = fileFor(scope);
    if (!file) return { doc: { v: 1, notes: [] }, file };
    const doc = readJson(file, null);
    if (!doc || !Array.isArray(doc.notes)) return { doc: { v: 1, notes: [] }, file };
    return { doc, file };
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

  return {
    format,

    ensure(scope) {
      const file = fileFor(scope);
      if (file) ensureDir(path.dirname(file));
      return file;
    },

    all(scope) {
      const { doc, file } = load(scope);
      if (!file) return [];
      return doc.notes.map((r) => hydrate(r, scope, file)).filter(Boolean);
    },

    get(scope, id) {
      const { doc, file } = load(scope);
      const rec = doc.notes.find((n) => n && n.id === id);
      return rec ? hydrate(rec, scope, file) : null;
    },

    put(note) {
      const { doc, file } = load(note.scope);
      const { file: _drop, ...clean } = note;
      const i = doc.notes.findIndex((n) => n && n.id === clean.id);
      if (i === -1) doc.notes.push(clean);
      else doc.notes[i] = clean;
      atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
      return { note: { ...clean, file: rel(p.root, file) }, file };
    },

    del(scope, id) {
      const { doc, file } = load(scope);
      const next = doc.notes.filter((n) => !n || n.id !== id);
      if (next.length === doc.notes.length) return false;
      doc.notes = next;
      atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
      return true;
    },
  };
}
