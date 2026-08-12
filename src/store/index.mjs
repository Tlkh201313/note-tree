/**
 * Store facade.
 *
 * Everything above this line (CLI, MCP, hooks, UI) talks to this module and
 * never to a driver directly. It owns the policy that must hold no matter which
 * format is configured: redaction, dedupe, journaling, read counting, scope
 * moves, and notifying listeners so the index and context files stay fresh.
 */

import { makeNote, checkBodyBudget, nowIso, normalizeTags, oneLine, newId } from '../note.mjs';
import { redactNote } from '../redact.mjs';
import { findDuplicate } from '../dedupe.mjs';
import { logNote } from '../journal.mjs';
import { KINDS } from '../config.mjs';
import { createDriver as markdownDriver } from './markdown.mjs';
import { createDriver as jsonlDriver } from './jsonl.mjs';
import { createDriver as jsonDriver } from './json.mjs';

const DRIVERS = { markdown: markdownDriver, jsonl: jsonlDriver, json: jsonDriver };
export const FORMATS = Object.keys(DRIVERS);

const SCOPES = ['project', 'global'];

/**
 * @param cfg  effective config from `loadConfig()` (carries `.paths`)
 * @param onChange  called after every mutation: `{ ev, note }`
 */
export function openStore(cfg, { onChange = null } = {}) {
  const p = cfg.paths;
  const format = DRIVERS[cfg.storage?.format] ? cfg.storage.format : 'markdown';
  const driver = DRIVERS[format](p);
  const journalFile = cfg.storage?.journal === false ? null : p.journal;

  const scopesAvailable = () => (p.projectDir ? SCOPES : ['global']);

  function notify(ev, note, extra = {}) {
    if (!onChange) return;
    try {
      onChange({ ev, note, ...extra });
    } catch {
      /* a listener must never break a write that already succeeded */
    }
  }

  function emit(ev, note, extra = {}) {
    logNote(journalFile, ev, note, extra);
    notify(ev, note, extra);
  }

  function listScope(scope, includeArchived) {
    if (scope === 'project' && !p.projectDir) return [];
    const notes = driver.all(scope);
    return includeArchived ? notes : notes.filter((n) => !n.archived);
  }

  const store = {
    format,
    driver,
    paths: p,

    ensure() {
      for (const scope of scopesAvailable()) driver.ensure(scope);
      return p;
    },

    /** @param scope 'project' | 'global' | 'all' */
    list({ scope = 'all', includeArchived = false } = {}) {
      const scopes = scope === 'all' ? scopesAvailable() : [scope];
      return scopes.flatMap((s) => listScope(s, includeArchived));
    },

    /** Look up by id; project is checked first because it's the narrower scope. */
    get(id, scope = null) {
      if (scope) return driver.get(scope, id);
      for (const s of scopesAvailable()) {
        const found = driver.get(s, id);
        if (found) return found;
      }
      return null;
    },

    /**
     * Create a note, or update one when `id` is supplied.
     *
     * Returns `{ status, note, warnings, redacted, duplicate }` where status is
     * `created` | `updated` | `duplicate`. A `duplicate` result writes nothing —
     * the caller is handed the existing note so it can update or supersede it.
     */
    write(input = {}, ctx = {}, opts = {}) {
      const warnings = [];
      const existing = input.id ? store.get(input.id, input.scope || null) : null;
      if (input.id && !existing && !opts.allowMissingId) {
        throw new Error(`no note with id "${input.id}"`);
      }

      const merged = existing
        ? {
            ...existing,
            ...stripUndefined(input),
            id: existing.id,
            created: existing.created,
            reads: existing.reads,
            updated: nowIso(),
          }
        : { ...input, id: input.id || newId() };

      let note = makeNote(merged, ctx);

      if (input.kind && !KINDS.includes(input.kind)) {
        warnings.push(`unknown kind "${input.kind}"; stored as "${note.kind}"`);
      }

      const bodyWarning = checkBodyBudget(note.body, cfg.budget?.noteBodyWords);
      if (bodyWarning) warnings.push(bodyWarning);

      const { note: clean, hits } = redactNote(note, cfg.privacy?.redactSecrets !== false);
      note = clean;
      if (hits.length) warnings.push(`redacted possible secrets (${hits.join(', ')})`);

      // Dedupe applies to new notes only — an explicit update is never a duplicate.
      if (!existing && !opts.force) {
        const dup = findDuplicate(note, listScope(note.scope, false), cfg.capture?.dedupeThreshold ?? 0.85);
        if (dup) {
          return {
            status: 'duplicate',
            note: null,
            duplicate: { ...dup.note, score: Number(dup.score.toFixed(3)) },
            warnings,
            redacted: hits,
          };
        }
      }

      if (note.scope === 'project' && !p.projectDir) {
        throw new Error('no project context: run `note-tree init` in a project, or use scope "global"');
      }

      const { note: saved } = driver.put(note);
      const status = existing ? 'updated' : 'created';
      emit(status === 'created' ? 'write' : 'update', saved);
      return { status, note: saved, warnings, redacted: hits };
    },

    /** Patch specific fields without re-running create-time validation semantics. */
    update(id, patch = {}, ctx = {}) {
      const found = store.get(id);
      if (!found) return null;
      return store.write({ ...patch, id: found.id, scope: patch.scope || found.scope }, ctx).note;
    },

    /**
     * Bump read counts. Reads feed ranking, so recall makes useful notes
     * surface sooner next time.
     */
    markRead(ids) {
      const list = Array.isArray(ids) ? ids : [ids];
      const out = [];
      for (const id of list) {
        const note = store.get(id);
        if (!note) continue;
        const { note: saved } = driver.put({ ...note, reads: (note.reads || 0) + 1 });
        out.push(saved);
      }
      if (out.length) {
        // Reads are frequent and low-value in the log, so record the batch as one
        // line — but every note still reaches listeners so the index stays exact.
        logNote(journalFile, 'read', out[0], { ids: out.map((n) => n.id), count: out.length });
        for (const n of out) notify('read', n);
      }
      return out;
    },

    /**
     * Pinning and archiving are curation, not authorship, so `updated` stays
     * put. Bumping it would make a two-year-old note you just pinned read as
     * "now" in the seed — a small lie the agent has no way to check.
     */
    setFlag(id, field, value) {
      const note = store.get(id);
      if (!note) return null;
      const { note: saved } = driver.put({ ...note, [field]: value });
      emit(field === 'archived' ? (value ? 'archive' : 'restore') : value ? 'pin' : 'unpin', saved);
      return saved;
    },

    archive: (id) => store.setFlag(id, 'archived', true),
    restore: (id) => store.setFlag(id, 'archived', false),
    pin: (id) => store.setFlag(id, 'pinned', true),
    unpin: (id) => store.setFlag(id, 'pinned', false),

    /** Move a note between scopes, keeping its id when that id is free. */
    move(id, toScope) {
      if (!SCOPES.includes(toScope)) throw new Error(`unknown scope "${toScope}"`);
      const note = store.get(id);
      if (!note) return null;
      if (note.scope === toScope) return note;
      if (toScope === 'project' && !p.projectDir) {
        throw new Error('no project context to demote into');
      }

      const fromScope = note.scope;
      const collision = driver.get(toScope, note.id);
      const moved = {
        ...note,
        id: collision ? newId() : note.id,
        scope: toScope,
        project: toScope === 'global' ? null : note.project || cfg.slug || null,
        updated: nowIso(),
      };
      const { note: saved } = driver.put(moved);
      driver.del(fromScope, note.id);
      emit(toScope === 'global' ? 'promote' : 'demote', saved, { from: fromScope, wasId: note.id });
      return saved;
    },

    promote: (id) => store.move(id, 'global'),
    demote: (id) => store.move(id, 'project'),

    remove(id) {
      const note = store.get(id);
      if (!note) return false;
      const ok = driver.del(note.scope, id);
      if (ok) emit('delete', note);
      return ok;
    },

    /** Counts for `status` / `doctor`, cheap enough to call interactively. */
    stats() {
      const out = { format, byScope: {}, total: 0, archived: 0, pinned: 0, kinds: {} };
      for (const scope of scopesAvailable()) {
        const notes = listScope(scope, true);
        out.byScope[scope] = notes.filter((n) => !n.archived).length;
        for (const n of notes) {
          if (n.archived) out.archived++;
          else {
            out.total++;
            if (n.pinned) out.pinned++;
            out.kinds[n.kind] = (out.kinds[n.kind] || 0) + 1;
          }
        }
      }
      return out;
    },
  };

  return store;
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export { normalizeTags, oneLine };
