/**
 * Ranking — deciding which few notes are worth a session's tokens.
 *
 * This is the quality half of the promise. Injecting fewer tokens is easy;
 * injecting the *right* fewer tokens is the part that has to be good. Four
 * signals, all cheap and all explainable:
 *
 *   pinned     you said it always matters          (dominant, by design)
 *   kind       a gotcha outranks a bookmark        (configurable weights)
 *   recency    exponential decay, configurable half-life
 *   reads      notes that keep proving useful rise
 *
 * Every term is exposed by `explain()` so `note-tree list --why` can show its
 * work. A ranking you can't inspect is a ranking you can't trust.
 */

const DAY_MS = 86_400_000;

/** Recency term, 0–10, halving every `halfLifeDays`. */
export function recencyScore(updated, halfLifeDays = 30, now = Date.now()) {
  const t = Date.parse(updated || '');
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (now - t) / DAY_MS);
  const half = halfLifeDays > 0 ? halfLifeDays : 30;
  return 10 * Math.pow(0.5, ageDays / half);
}

export function explain(entry, cfg = {}, now = Date.now()) {
  const r = cfg.ranking || {};
  const weights = r.kindWeights || {};
  const parts = {
    pinned: entry.pinned ? r.pinnedBoost ?? 1000 : 0,
    kind: (weights[entry.kind] ?? 0) * 2,
    recency: recencyScore(entry.updated || entry.created, r.halfLifeDays ?? 30, now),
    reads: (r.readBoost ?? 2) * Math.log2(1 + Math.max(0, entry.reads || 0)),
  };
  parts.total = parts.pinned + parts.kind + parts.recency + parts.reads;
  return parts;
}

export function scoreNote(entry, cfg = {}, now = Date.now()) {
  return explain(entry, cfg, now).total;
}

/**
 * Rank a list, highest first. Archived notes are dropped unless asked for.
 * Ties break on `updated` so the order is stable between runs.
 */
export function rankNotes(entries, cfg = {}, { now = Date.now(), includeArchived = false } = {}) {
  const list = includeArchived ? entries : entries.filter((e) => !e.archived);
  return list
    .map((e) => ({ entry: e, score: scoreNote(e, cfg, now) }))
    .sort((a, b) => b.score - a.score || String(b.entry.updated).localeCompare(String(a.entry.updated)))
    .map((x) => ({ ...x.entry, score: x.score }));
}

/**
 * Pick what a session gets: the top project notes plus the top global ones,
 * each capped separately so a busy project can never crowd out the lessons you
 * deliberately promoted to global.
 */
export function selectForSeed(projectEntries, globalEntries, cfg = {}, now = Date.now()) {
  const b = cfg.budget || {};
  const project = rankNotes(projectEntries, cfg, { now }).slice(0, b.projectNotes ?? 16);
  const global = rankNotes(globalEntries, cfg, { now }).slice(0, b.globalNotes ?? 5);
  return { project, global };
}

/**
 * Group notes into the branches the tree renders: one branch per session,
 * oldest first, so geometry stays stable as new notes arrive.
 */
export function groupBySession(entries) {
  const branches = new Map();
  for (const e of entries) {
    const key = e.session || 'unsessioned';
    if (!branches.has(key)) branches.set(key, { session: key, notes: [], first: e.created, last: e.created });
    const b = branches.get(key);
    b.notes.push(e);
    if (e.created < b.first) b.first = e.created;
    if (e.created > b.last) b.last = e.created;
  }
  return [...branches.values()].sort((a, b) => String(a.first).localeCompare(String(b.first)));
}
