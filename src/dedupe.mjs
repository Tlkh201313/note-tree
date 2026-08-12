/**
 * Near-duplicate detection.
 *
 * The tree stays useful only if it stays signal-dense. Agents restating a fact
 * they already recorded should update or supersede the existing leaf rather than
 * grow a twin next to it, so every write is checked against what's already there.
 *
 * Trigram Dice coefficient: cheap, language-agnostic, no dependencies, and
 * tolerant of rewording — which is exactly how an agent restates itself.
 */

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for',
  'and', 'or', 'we', 'it', 'this', 'that', 'with', 'as', 'by', 'at', 'from', 'use',
  'uses', 'using', 'should', 'must', 'when', 'not',
]);

/** Lowercase, strip punctuation, drop filler words. */
export function normalizeText(s) {
  const words = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  return words.join(' ');
}

function trigrams(s) {
  const padded = `  ${s} `;
  const set = new Set();
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  return set;
}

/** Dice coefficient of two trigram sets: 0 (nothing shared) to 1 (identical). */
export function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = trigrams(na);
  const tb = trigrams(nb);
  if (!ta.size || !tb.size) return 0;

  let shared = 0;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const g of small) if (large.has(g)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/** Title dominates — two notes about the same thing usually agree there first. */
export function noteSimilarity(a, b) {
  const title = similarity(a.title, b.title);
  const body = similarity(String(a.body ?? '').slice(0, 400), String(b.body ?? '').slice(0, 400));
  return 0.7 * title + 0.3 * body;
}

/**
 * Best near-duplicate of `candidate` among `notes`, or null.
 * Archived notes and the candidate itself are ignored.
 */
export function findDuplicate(candidate, notes, threshold = 0.85) {
  if (!threshold || threshold <= 0) return null;
  let best = null;
  for (const n of notes) {
    if (!n || n.id === candidate.id || n.archived) continue;
    const score = noteSimilarity(candidate, n);
    if (score >= threshold && (!best || score > best.score)) best = { note: n, score };
  }
  return best;
}
