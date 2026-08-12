/**
 * Search over the index.
 *
 * No embeddings, no vector database, no index build step — a scan over a few
 * hundred metadata entries is microseconds, and it works offline, on any
 * machine, with zero dependencies. Bodies are only read when you ask for
 * `deep`, because reading them is the expensive part.
 *
 * Query syntax is the one people already have muscle memory for:
 *
 *   pagination                     free text
 *   kind:gotcha tag:api            filters
 *   scope:global agent:codex       filters
 *   pinned:true                    flags
 *   "exact phrase"                 phrase match
 *   -deprecated                    exclusion
 */

import { rankNotes, scoreNote } from './rank.mjs';

const FIELD_WEIGHTS = { title: 6, tags: 4, desc: 3, kind: 2, body: 1 };
const FILTERS = new Set(['kind', 'tag', 'tags', 'scope', 'agent', 'session', 'project', 'id']);
const FLAGS = new Set(['pinned', 'archived']);

/** Split a query into filters, phrases, terms and exclusions. */
export function parseQuery(query) {
  const out = { terms: [], phrases: [], exclude: [], filters: {}, flags: {} };
  const src = String(query ?? '').trim();
  if (!src) return out;

  const re = /(-)?(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  let m;
  while ((m = re.exec(src))) {
    const [, neg, rawKey, phrase, word] = m;
    const key = rawKey ? rawKey.toLowerCase() : null;
    const value = (phrase ?? word ?? '').toLowerCase();
    if (!value) continue;

    if (key && FILTERS.has(key)) {
      const k = key === 'tags' ? 'tag' : key;
      (out.filters[k] ||= []).push(value);
    } else if (key && FLAGS.has(key)) {
      out.flags[key] = !/^(false|no|0)$/.test(value);
    } else if (neg) {
      out.exclude.push(value);
    } else if (phrase !== undefined) {
      out.phrases.push(value);
    } else {
      out.terms.push(key ? `${key}:${value}` : value);
    }
  }
  return out;
}

function haystack(entry, deep) {
  return {
    title: String(entry.title || '').toLowerCase(),
    desc: String(entry.desc || '').toLowerCase(),
    tags: (entry.tags || []).join(' ').toLowerCase(),
    kind: String(entry.kind || '').toLowerCase(),
    body: deep ? String(entry.body || '').toLowerCase() : '',
  };
}

function passesFilters(entry, q) {
  for (const [key, values] of Object.entries(q.filters)) {
    const hit = values.some((v) => {
      if (key === 'tag') return (entry.tags || []).some((t) => String(t).toLowerCase() === v);
      if (key === 'id') return String(entry.id).toLowerCase() === v;
      return String(entry[key] ?? '').toLowerCase() === v;
    });
    if (!hit) return false;
  }
  for (const [flag, want] of Object.entries(q.flags)) {
    if (Boolean(entry[flag]) !== want) return false;
  }
  return true;
}

/** Text relevance of one entry, or -1 when a required term is missing. */
export function matchScore(entry, q, deep = false) {
  const h = haystack(entry, deep);
  const all = `${h.title} ${h.desc} ${h.tags} ${h.kind} ${h.body}`;

  for (const bad of q.exclude) if (all.includes(bad)) return -1;
  for (const phrase of q.phrases) if (!all.includes(phrase)) return -1;

  if (!q.terms.length && !q.phrases.length) return 0; // filters only — everything matching passes

  let score = 0;
  let matched = 0;
  for (const term of q.terms) {
    let best = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const hay = h[field];
      if (!hay) continue;
      const at = hay.indexOf(term);
      if (at === -1) continue;
      // A hit at a word boundary beats one buried mid-word.
      const boundary = at === 0 || /[^a-z0-9]/.test(hay[at - 1]);
      const whole = boundary && !/[a-z0-9]/.test(hay[at + term.length] || '');
      best = Math.max(best, weight * (whole ? 1.6 : boundary ? 1.25 : 0.7));
    }
    if (best > 0) matched++;
    score += best;
  }
  for (const phrase of q.phrases) {
    score += h.title.includes(phrase) ? FIELD_WEIGHTS.title * 1.6 : FIELD_WEIGHTS.desc;
    matched++;
  }

  // Every term must land somewhere — otherwise a one-word coincidence would
  // outrank a note that actually matches the whole query.
  if (q.terms.length && matched < q.terms.length) return -1;
  return score;
}

/**
 * Search `entries` (index entries, or full notes when `deep`).
 * Relevance dominates; rank breaks ties, so a stale exact hit still wins over a
 * fresh vague one, but two equal matches order by usefulness.
 */
export function searchEntries(entries, query, cfg = {}, opts = {}) {
  const { deep = false, limit = 20, includeArchived = false, now = Date.now() } = opts;
  const q = parseQuery(query);
  const filtersOnly = !q.terms.length && !q.phrases.length;

  const hits = [];
  for (const entry of entries) {
    if (!includeArchived && entry.archived && q.flags.archived === undefined) continue;
    if (!passesFilters(entry, q)) continue;
    const relevance = matchScore(entry, q, deep);
    if (relevance < 0) continue;
    hits.push({ ...entry, relevance, score: scoreNote(entry, cfg, now) });
  }

  if (filtersOnly) {
    return rankNotes(hits, cfg, { now, includeArchived: true }).slice(0, limit);
  }
  hits.sort((a, b) => b.relevance - a.relevance || b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Search a live store. Metadata-only by default; `deep` loads bodies for the
 * entries that already passed filtering, so full-text costs reads proportional
 * to candidates rather than to the whole store.
 */
export function search(store, entriesByScope, query, cfg = {}, opts = {}) {
  const { deep = false } = opts;
  let pool = entriesByScope;

  if (deep) {
    const q = parseQuery(query);
    pool = entriesByScope
      .filter((e) => passesFilters(e, q))
      .map((e) => {
        const full = store.get(e.id, e.scope);
        return full ? { ...e, body: full.body } : e;
      });
  }
  return searchEntries(pool, query, cfg, opts);
}
