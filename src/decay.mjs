/**
 * Leaf lifecycle — how a note ages on the tree.
 *
 * A note earns its place by being useful; if it stops being useful it should
 * stop taking up space. This is the *time* half of that promise. A note nobody
 * edits or recalls slowly withers — its leaf shrinks and fades — and once it
 * has been dormant long enough, and isn't one you told us to keep, it falls:
 * archived out of the session seed so it stops costing tokens, never deleted,
 * always restorable.
 *
 * Two things keep a leaf green. Recalls buy grace: every time a note is read it
 * earns more dormant days before it starts to wither, so a note you keep leaning
 * on stays full-sized — the mirror of "used a lot → bigger". And some notes are
 * shielded outright: anything pinned, and the high-value kinds (`gotcha`,
 * `decision` by default) that are worth keeping even when they sit unused for a
 * year.
 *
 * Everything here is pure and deterministic: age is measured against a passed-in
 * `now`, never the wall clock, so the tree renders identically in a test and in
 * a browser.
 */

const DAY_MS = 86_400_000;

const DEFAULTS = {
  enabled: true,
  // A leaf holds full size and colour until it has been dormant this long.
  witherAfterDays: 45,
  // Dormant past here (and unprotected) → it falls: archived, recoverable.
  fallAfterDays: 180,
  // Each recall is worth this many dormant days of grace, capped, so a note you
  // keep recalling resists withering.
  gracePerRead: 15,
  maxGraceDays: 120,
  // Kinds worth keeping even when unused — never wither, never fall.
  protectKinds: ['gotcha', 'decision'],
};

/** Merge the user's `decay` config over the defaults. */
export function decayConfig(cfg = {}) {
  return { ...DEFAULTS, ...(cfg.decay || {}) };
}

/** Days since the note was last authored/edited. Recall does not reset this. */
function dormantDays(entry, now) {
  const t = Date.parse(entry.updated || entry.created || '');
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY_MS) : 0;
}

/** Dormant days minus the grace a note's recalls have earned it. */
function effectiveDormant(entry, d, now) {
  const grace = Math.min(d.maxGraceDays, (entry.reads || 0) * d.gracePerRead);
  return dormantDays(entry, now) - grace;
}

/**
 * Is this note shielded from ageing? Pinned notes and the protected kinds never
 * wither or fall, however long they sit. (Reads only slow decay, via grace —
 * they don't shield outright, because even a once-popular note can go stale.)
 */
export function isProtected(entry, d = DEFAULTS) {
  return Boolean(entry.pinned) || (d.protectKinds || []).includes(entry.kind);
}

/**
 * Wither factor, 0 (fresh) .. 1 (fully withered, about to fall). Drives how much
 * a leaf shrinks and fades before it drops. Protected or disabled → always 0.
 *
 * @param d  a resolved decay config from `decayConfig(cfg)`
 */
export function witherFactor(entry, d = DEFAULTS, now = Date.now()) {
  if (!d.enabled || entry.archived || isProtected(entry, d)) return 0;
  const dormant = effectiveDormant(entry, d, now);
  if (dormant <= d.witherAfterDays) return 0;
  const span = Math.max(1, d.fallAfterDays - d.witherAfterDays);
  return Math.min(1, (dormant - d.witherAfterDays) / span);
}

/** Has the note been dormant long enough — and is it eligible — to fall? */
export function hasFallen(entry, d = DEFAULTS, now = Date.now()) {
  if (!d.enabled || entry.archived || isProtected(entry, d)) return false;
  return effectiveDormant(entry, d, now) >= d.fallAfterDays;
}

/** The live notes that should be archived right now. Never includes protected ones. */
export function fallen(entries, d = DEFAULTS, now = Date.now()) {
  return entries.filter((e) => !e.archived && hasFallen(e, d, now));
}

/**
 * Retire the fallen leaves: archive every dormant, unprotected note, bounded so
 * a first run on a long-neglected tree doesn't archive hundreds in one go. The
 * caller does the cheap `fallen()` check first and only opens a writable context
 * when something is actually due, so this is free on a healthy tree.
 *
 * Returns the ids it archived.
 */
export function sweepFallen(ctx, { now = Date.now(), max = 25 } = {}) {
  const d = decayConfig(ctx.cfg);
  if (!d.enabled) return [];
  const due = fallen(ctx.allEntries(), d, now).slice(0, Math.max(0, max));
  for (const n of due) ctx.store.archive(n.id);
  return due.map((n) => n.id);
}
