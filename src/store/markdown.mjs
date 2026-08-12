/**
 * Markdown driver (default).
 *
 * One note = one `<id>-<slug>.md` file with YAML frontmatter. Human-readable,
 * greppable, diffable, and safe for two agents to write at once because each
 * note owns its own file and every write is atomic.
 */

import path from 'node:path';
import { notesDir } from '../paths.mjs';
import { serializeNote, deserializeNote } from '../note.mjs';
import { ensureDir, listFiles, readTextSafe, atomicWrite, removeFile, slugify } from '../fsutil.mjs';

export const format = 'markdown';

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

export function createDriver(p) {
  const dirFor = (scope) => notesDir(p, scope);

  function fileName(note) {
    return `${note.id}-${slugify(note.title)}.md`;
  }

  /** Locate the file holding `id`, tolerating a stale slug in the name. */
  function findFile(scope, id) {
    const dir = dirFor(scope);
    if (!dir) return null;
    const match = listFiles(dir, '.md').find((n) => n === `${id}.md` || n.startsWith(`${id}-`));
    return match ? path.join(dir, match) : null;
  }

  return {
    format,

    ensure(scope) {
      const dir = dirFor(scope);
      if (dir) ensureDir(dir);
      return dir;
    },

    all(scope) {
      const dir = dirFor(scope);
      if (!dir) return [];
      const out = [];
      for (const name of listFiles(dir, '.md')) {
        const file = path.join(dir, name);
        const text = readTextSafe(file);
        if (text === null) continue;
        const note = deserializeNote(text, { scope });
        if (!note) continue;
        // The filename is the source of truth for identity: a copied file with a
        // duplicated id in its frontmatter would otherwise shadow the original.
        const idFromName = name.replace(/\.md$/i, '').split('-')[0];
        if (idFromName && note.id !== idFromName) note.id = idFromName;
        note.scope = scope;
        out.push({ ...note, file: rel(p.root, file) });
      }
      return out;
    },

    get(scope, id) {
      const file = findFile(scope, id);
      if (!file) return null;
      const text = readTextSafe(file);
      if (text === null) return null;
      const note = deserializeNote(text, { scope });
      if (!note) return null;
      note.id = id;
      note.scope = scope;
      return { ...note, file: rel(p.root, file) };
    },

    put(note) {
      const dir = dirFor(note.scope);
      ensureDir(dir);
      const target = path.join(dir, fileName(note));
      const existing = findFile(note.scope, note.id);
      const { file: _drop, ...clean } = note;
      atomicWrite(target, serializeNote(clean));
      // A retitled note gets a new filename; drop the old one so it isn't listed twice.
      if (existing && path.resolve(existing) !== path.resolve(target)) removeFile(existing);
      return { note: { ...clean, file: rel(p.root, target) }, file: target };
    },

    del(scope, id) {
      const file = findFile(scope, id);
      return file ? removeFile(file) : false;
    },
  };
}
