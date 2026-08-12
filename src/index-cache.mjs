/**
 * The index cache — what makes session start fast.
 *
 * Note bodies live in files; their *metadata* lives in a generated
 * `index.json` per scope. The SessionStart hot path reads only those two small
 * JSON files (project + global) and never opens a note. Bodies load on demand.
 *
 * Freshness strategy, in order of cost:
 *   1. Our own writes update the index incrementally — O(1), always fresh.
 *   2. If the notes directory changed behind our back, `reconcile()` re-reads
 *      only the files that appeared or vanished (one `readdir`, not N reads).
 *   3. `note-tree sync` does the full rebuild, for hand-edited note bodies.
 *
 * Steps 1 and 2 are what the hot path is allowed to do. Step 3 never runs
 * implicitly, because it costs one file read per note.
 */

import fs from 'node:fs';
import path from 'node:path';
import { toIndexEntry } from './note.mjs';
import { readJson, atomicWrite, listFiles, exists } from './fsutil.mjs';

export const INDEX_VERSION = 1;

const EMPTY = { v: INDEX_VERSION, generated: null, count: 0, notes: [] };

/** Where a scope's index lives. Global and each project get their own. */
export function indexPathFor(p, scope) {
  if (scope === 'global') return p.globalDir ? path.join(p.globalDir, 'index.json') : null;
  return p.projectDir ? path.join(p.projectDir, 'index.json') : null;
}

/** The directory (markdown) or file (jsonl/json) whose mtime signals a change. */
function watchTarget(p, scope, format) {
  if (format === 'markdown') return scope === 'global' ? p.globalNotes : p.projectNotes;
  if (format === 'jsonl') return scope === 'global' ? p.globalStore : p.projectStore;
  const dir = scope === 'global' ? p.globalDir : p.projectDir;
  return dir ? path.join(dir, 'notes.json') : null;
}

function mtimeMs(target) {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Has anything changed since we generated this index?
 *
 * One `stat` per scope — the cheapest possible freshness check, and the reason
 * the hot path can trust the cache without opening a single note.
 */
export function isStale(p, scope, format, doc) {
  if (!doc || !doc.generated) return true;
  const target = watchTarget(p, scope, format);
  if (!target) return false;
  return doc.source !== mtimeMs(target);
}

export function loadIndex(p, scope) {
  const file = indexPathFor(p, scope);
  if (!file) return { ...EMPTY, notes: [] };
  const doc = readJson(file, null);
  if (!doc || doc.v !== INDEX_VERSION || !Array.isArray(doc.notes)) return { ...EMPTY, notes: [] };
  return doc;
}

export function saveIndex(p, scope, notes, format) {
  const file = indexPathFor(p, scope);
  if (!file) return null;
  const doc = {
    v: INDEX_VERSION,
    generated: new Date().toISOString(),
    source: mtimeMs(watchTarget(p, scope, format)),
    format,
    scope,
    count: notes.length,
    notes,
  };
  try {
    atomicWrite(file, JSON.stringify(doc));
    return doc;
  } catch {
    return null;
  }
}

const entryOf = (note) => toIndexEntry(note, note.file || null);

/** Full rebuild from the store. One file read per note — never on the hot path. */
export function rebuild(store, scope) {
  const notes = store.driver.all(scope).map(entryOf);
  notes.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return saveIndex(store.paths, scope, notes, store.format);
}

/**
 * Fast freshness repair.
 *
 * Markdown: compare the filenames on disk to the ones in the index and read
 * only the difference. Single-file formats: one read if the file moved on.
 * Returns the (possibly updated) index document.
 */
export function reconcile(store, scope) {
  const p = store.paths;
  const target = watchTarget(p, scope, store.format);
  if (!target) return { ...EMPTY, notes: [] };

  const doc = loadIndex(p, scope);
  const stamp = mtimeMs(target);
  if (doc.generated && doc.source === stamp) return doc; // untouched since we wrote it

  if (store.format !== 'markdown') {
    // The whole scope is one file; re-reading it *is* the cheap path.
    return rebuild(store, scope) || doc;
  }

  if (!exists(target)) return saveIndex(p, scope, [], store.format) || { ...EMPTY, notes: [] };

  const onDisk = new Set(listFiles(target, '.md'));
  const kept = [];
  let changed = false;

  for (const entry of doc.notes) {
    const base = entry.file ? entry.file.split('/').pop() : null;
    if (base && onDisk.has(base)) {
      kept.push(entry);
      onDisk.delete(base);
    } else {
      changed = true; // deleted or renamed behind our back
    }
  }

  // Whatever is left on disk is new to us — those are the only files we read.
  for (const name of onDisk) {
    const id = name.replace(/\.md$/i, '').split('-')[0];
    const note = store.driver.get(scope, id);
    if (note) {
      kept.push(entryOf(note));
      changed = true;
    }
  }

  if (!changed && doc.generated) {
    // Only the directory timestamp moved; re-stamp so we don't re-check next time.
    return saveIndex(p, scope, kept, store.format) || doc;
  }
  kept.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return saveIndex(p, scope, kept, store.format) || doc;
}

/** Insert or replace one entry. Called after every write — keeps the index hot. */
export function upsertEntry(store, note) {
  const p = store.paths;
  const doc = loadIndex(p, note.scope);
  const entry = entryOf(note);
  const i = doc.notes.findIndex((n) => n.id === note.id);
  if (i === -1) doc.notes.push(entry);
  else doc.notes[i] = entry;
  return saveIndex(p, note.scope, doc.notes, store.format);
}

export function removeEntry(store, scope, id) {
  const p = store.paths;
  const doc = loadIndex(p, scope);
  const next = doc.notes.filter((n) => n.id !== id);
  if (next.length === doc.notes.length) return doc;
  return saveIndex(p, scope, next, store.format);
}

/**
 * Entries for a scope, as the hot path wants them.
 * `reconcile: false` skips even the mtime check — used by the benchmark and by
 * callers that just refreshed.
 */
export function entries(store, scope, { reconcile: doReconcile = true } = {}) {
  if (scope === 'project' && !store.paths.projectDir) return [];
  const doc = doReconcile ? reconcile(store, scope) : loadIndex(store.paths, scope);
  return doc.notes || [];
}

/* ------------------------------------------------------------------ *
 * Registry — the forest view
 * ------------------------------------------------------------------ */

/**
 * `~/.note-tree/index.json` lists every project note-tree has seen, so the UI
 * can render the forest and `status` can report it without walking the store.
 */
export function loadRegistry(p) {
  const doc = readJson(p.index, null);
  if (!doc || doc.v !== INDEX_VERSION) return { v: INDEX_VERSION, generated: null, projects: {}, global: { count: 0 } };
  return doc;
}

export function touchRegistry(store, { slug, cwd, counts } = {}) {
  const p = store.paths;
  const reg = loadRegistry(p);
  reg.generated = new Date().toISOString();
  reg.global = { count: counts?.global ?? reg.global?.count ?? 0, updated: reg.generated };

  if (slug) {
    const prev = reg.projects[slug] || { cwds: [] };
    const cwds = new Set(prev.cwds || []);
    if (cwd) cwds.add(cwd);
    reg.projects[slug] = {
      slug,
      cwds: [...cwds],
      count: counts?.project ?? prev.count ?? 0,
      updated: reg.generated,
    };
  }
  try {
    atomicWrite(p.index, JSON.stringify(reg, null, 2) + '\n');
  } catch {
    /* the registry is a convenience, not a dependency */
  }
  return reg;
}

/**
 * Wire index maintenance into a store's mutation events.
 * Pass as `openStore(cfg, { onChange: indexListener(getStore) })`.
 */
export function applyChange(store, { ev, note, from, wasId } = {}) {
  if (!note) return;
  if (ev === 'delete') {
    removeEntry(store, note.scope, note.id);
    return;
  }
  if (ev === 'promote' || ev === 'demote') {
    // A move leaves one scope and joins another, and may have been reissued a
    // new id to dodge a collision — so drop the *old* id from the *old* scope.
    const oldScope = from || (note.scope === 'global' ? 'project' : 'global');
    removeEntry(store, oldScope, wasId || note.id);
    upsertEntry(store, note);
    return;
  }
  upsertEntry(store, note);
}
