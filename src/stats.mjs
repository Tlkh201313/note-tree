/**
 * Usage stats, computed from the journal alone — no extra store, no network.
 *
 * The questions it answers are the ones every later memory feature depends on:
 * do agents read what we inject, do they search, do they save, and does the Stop
 * nudge ever get answered. Lines from older versions (no `by`/`via`/`injected`)
 * are tolerated; they just contribute to the counts they can.
 */

import { readAll } from './journal.mjs';

const DAY = 86_400_000;

/** The journal plus its rotations, oldest first. */
export function readJournals(journalFile) {
  return [`${journalFile}.2`, `${journalFile}.1`, journalFile].flatMap((f) => readAll(f));
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
const avg = (n, d) => (d ? Math.round((10 * n) / d) / 10 : null);

/**
 * @param {object[]} events journal lines, any order
 * @param {{ days?: number, now?: number }} opts
 */
export function computeStats(events, { days = 30, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const inWindow = events.filter((e) => Date.parse(e.t || '') >= since);

  const ended = inWindow.filter((e) => e.ev === 'session-end' && e.session);
  // Only sessions that recorded what they injected can say how much of it was used.
  const measured = ended.filter((e) => Array.isArray(e.injected));
  const sids = new Set(measured.map((e) => e.session));

  // Reads and searches the *agent* chose to make (not a person in the CLI or UI).
  const agentReads = inWindow.filter((e) => e.ev === 'read' && e.via === 'mcp' && e.by);
  const searches = inWindow.filter((e) => e.ev === 'search' && e.by);
  const writes = inWindow.filter((e) => e.ev === 'write');

  const touching = (list, key) => new Set(list.map((e) => e[key]).filter((s) => sids.has(s)));
  const reading = touching(agentReads, 'by');
  const searching = touching(searches, 'by');
  const saving = touching(writes, 'session');
  const active = new Set([...reading, ...searching]);

  const injected = new Set(measured.flatMap((e) => e.injected));
  const readIds = new Set(inWindow.filter((e) => e.ev === 'read').flatMap((e) => e.ids || [e.id]));
  const unread = [...injected].filter((id) => !readIds.has(id));

  const kinds = {};
  for (const w of writes) kinds[w.kind] = (kinds[w.kind] || 0) + 1;
  const nudges = ended.reduce((n, e) => n + (e.nudges || 0), 0);
  const answered = ended.reduce((n, e) => n + (e.answered || 0), 0);

  return {
    days,
    sessions: { total: ended.length, measured: measured.length },
    injected: { perSession: avg(measured.reduce((n, e) => n + e.injected.length, 0), measured.length), distinct: injected.size, neverRead: unread.length },
    agent: {
      readPct: pct(reading.size, measured.length),
      searchPct: pct(searching.size, measured.length),
      eitherPct: pct(active.size, measured.length),
      searches: searches.length,
      searchesWithNoHits: searches.filter((s) => !s.hits).length,
    },
    saves: { total: writes.length, sessionsSavingPct: pct(saving.size, measured.length), perSession: avg(writes.length, ended.length) },
    nudges: { fired: nudges, answered, answeredPct: pct(answered, nudges) },
    kinds,
  };
}
