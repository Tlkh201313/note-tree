/**
 * Path resolution and project identity.
 *
 * Deliberately dependency-free and import-light: this module sits on the
 * SessionStart hot path, so it avoids `node:crypto` in favour of a tiny
 * inline hash.
 */

import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const IS_WIN = process.platform === 'win32';

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

/**
 * FNV-1a (32-bit). Not cryptographic — we only need short, stable,
 * collision-resistant-enough ids without paying for a `node:crypto` import.
 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Short base36 hash, zero-padded to a fixed width. */
export function shortHash(str, len = 6) {
  return hash32(str).toString(36).padStart(len, '0').slice(-len);
}

/**
 * Storage root, most specific source first:
 * explicit argument (`--root`) > `NOTE_TREE_HOME` > `storage.root` in config > default.
 *
 * The env var sits above the config file so tests and power users can redirect
 * everything without touching the real store, but below an explicit flag so
 * `--root` always means what it says.
 */
export function rootDir(explicitRoot, configuredRoot = null) {
  return expandTilde(
    explicitRoot || process.env.NOTE_TREE_HOME || configuredRoot || path.join(HOME, '.note-tree'),
  );
}

/**
 * Stable identifier for a working directory.
 *
 * Readable prefix + hash of the absolute path, so two folders that share a
 * basename (`~/work/api` and `~/personal/api`) never collide. Windows paths are
 * lowercased before hashing because the filesystem is case-insensitive there —
 * without this, `C:\Foo` and `c:\foo` would become two separate projects.
 */
export function projectSlug(cwd = process.cwd()) {
  const abs = path.resolve(cwd);
  const key = IS_WIN ? abs.toLowerCase() : abs;
  const base =
    path
      .basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40) || 'project';
  return `${base}-${shortHash(key)}`;
}

/** Every path note-tree knows about, resolved from a root (+ optional project). */
export function paths(root, slug = null, configuredRoot = null) {
  const r = rootDir(root, configuredRoot);
  const p = {
    root: r,
    config: path.join(r, 'config.json'),
    index: path.join(r, 'index.json'),
    journal: path.join(r, 'journal.jsonl'),
    backups: path.join(r, 'backups'),
    sessions: path.join(r, 'sessions'),
    globalDir: path.join(r, 'global'),
    globalNotes: path.join(r, 'global', 'notes'),
    globalStore: path.join(r, 'global', 'notes.jsonl'),
    projectsDir: path.join(r, 'projects'),
    projectDir: null,
    projectNotes: null,
    projectStore: null,
    projectMeta: null,
    projectConfig: null,
  };
  if (slug) {
    const d = path.join(r, 'projects', slug);
    p.projectDir = d;
    p.projectNotes = path.join(d, 'notes');
    p.projectStore = path.join(d, 'notes.jsonl');
    p.projectMeta = path.join(d, 'meta.json');
    p.projectConfig = path.join(d, 'config.json');
  }
  return p;
}

/** Directory holding notes for a given scope. */
export function notesDir(p, scope) {
  return scope === 'global' ? p.globalNotes : p.projectNotes;
}
