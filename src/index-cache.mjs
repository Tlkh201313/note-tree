/**
 * The index cache — what makes session start fast.
 *
 * Note bodies live in files; their *metadata* lives in a generated
 * `index.json` per scope. The SessionStart hot path reads only those two small
 * JSON files (project + global) and never opens a note. Bodies load on demand.
 *
 * Freshness strategy, in order of cost:
 *   1. Our own writes update the index in place, after the step-2 scan, so
 *      they never stamp someone else's unindexed change as fresh.
 *   2. If the notes directory changed behind our back, `reconcile()` re-reads
 *      only the files that appeared, vanished or were edited since the index
 *      was generated (one `readdir` and a `stat` per note, not N reads).
 *   3. `note-tree sync` does the full rebuild. An editor that saves in place
 *      doesn't touch the directory's mtime, so its edit waits for the next
 *      write or a sync.
 *
 * Every index save happens under a lock file: two agents saving at once would
 * otherwise each write back a list missing the other's note.
 *
 * Steps 1 and 2 are what the hot path is allowed to do. Step 3 never runs
 * implicitly, because it costs one file read per note.
 */

import fs from 'node:fs';
import path from 'node:path';
import { toIndexEntry } from './note.mjs';
import { readJson, atomicWrite, listFiles, exists, withLock } from './fsutil.mjs';

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

export function saveIndex(p, scope, notes, format, stamp = null) {
  const file = indexPathFor(p, scope);
  if (!file) return null;
  const doc = {
    v: INDEX_VERSION,
    generated: new Date().toISOString(),
    source: stamp ?? mtimeMs(watchTarget(p, scope, format)),
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
const byCreated = (a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);

/**
 * What the index should hold right now, without saving it.
 *
 * Markdown: compare the filenames on disk to the ones in the index, and read
 * only the files that are new or were modified after the index was generated —
 * a hand edit keeps its filename, so the name alone can't reveal it.
 * Single-file formats: the whole scope is one file; re-reading it *is* the
 * cheap path.
 *
 * `stamp` is the watch target's mtime taken *before* looking, so a write that
 * lands mid-scan leaves the saved index stale rather than wrongly fresh.
 */
function scan(store, scope, doc) {
  const target = watchTarget(store.paths, scope, store.format);
  const stamp = mtimeMs(target);
  if (store.format !== 'markdown') return { notes: store.driver.all(scope).map(entryOf).sort(byCreated), stamp };
  if (!exists(target)) return { notes: [], stamp };

  const since = Date.parse(doc.generated || '') || 0;
  const onDisk = new Set(listFiles(target, '.md'));
  const notes = [];
  for (const entry of doc.notes) {
    const base = entry.file ? entry.file.split('/').pop() : null;
    // Deleted or renamed behind our back → dropped; edited since → re-read below.
    if (base && onDisk.has(base) && mtimeMs(path.join(target, base)) <= since) {
      notes.push(entry);
      onDisk.delete(base);
    }
  }
  // Whatever is left on disk is new or changed — those are the only files we read.
  for (const name of onDisk) {
    const note = store.driver.get(scope, name.replace(/\.md$/i, '').split('-')[0]);
    if (note) notes.push(entryOf(note));
  }
  return { notes: notes.sort(byCreated), stamp };
}

/** Full rebuild from the store. One file read per note — never on the hot path. */
export function rebuild(store, scope) {
  const file = indexPathFor(store.paths, scope);
  if (!file) return null;
  return withLock(file, () => {
    const stamp = mtimeMs(watchTarget(store.paths, scope, store.format));
    const notes = store.driver.all(scope).map(entryOf).sort(byCreated);
    return saveIndex(store.paths, scope, notes, store.format, stamp);
  });
}

/**
 * Fast freshness repair. Returns the (possibly updated) index document.
 *
 * The hot path calls this, so it waits only briefly for the lock: a busy lock
 * means another process is saving right now, and an unsaved but correct list
 * still renders this session.
 */
export function reconcile(store, scope) {
  const p = store.paths;
  const file = indexPathFor(p, scope);
  if (!file || !watchTarget(p, scope, store.format)) return { ...EMPTY, notes: [] };
  const doc = loadIndex(p, scope);
  if (!isStale(p, scope, store.format, doc)) return doc; // untouched since we wrote it

  return withLock(
    file,
    (held) => {
      const current = held ? loadIndex(p, scope) : doc;
      if (held && !isStale(p, scope, store.format, current)) return current; // someone beat us to it
      const { notes, stamp } = scan(store, scope, current);
      return (held && saveIndex(p, scope, notes, store.format, stamp)) || { ...current, notes, count: notes.length };
    },
    { waitMs: 150 },
  );
}

/**
 * Apply one change under the index lock, after bringing the index up to date
 * with the disk — so a note another process saved, or a file edited by hand,
 * is read rather than stamped "fresh" without ever being looked at.
 */
function mutate(store, scope, change) {
  const p = store.paths;
  const file = indexPathFor(p, scope);
  if (!file) return null;
  return withLock(file, () => {
    const { notes, stamp } = scan(store, scope, loadIndex(p, scope));
    return saveIndex(p, scope, change(notes), store.format, stamp);
  });
}

/** Insert or replace one entry. Called after every write — keeps the index hot. */
export function upsertEntry(store, note) {
  const entry = entryOf(note);
  return mutate(store, note.scope, (notes) => [...notes.filter((n) => n.id !== note.id), entry].sort(byCreated));
}

export function removeEntry(store, scope, id) {
  return mutate(store, scope, (notes) => notes.filter((n) => n.id !== id));
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
  // One file lists every project, so two projects saving together would each
  // read the old list and the later write would drop the other's entry.
  return withLock(p.index, () => {
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
  }, { waitMs: 500 });
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
