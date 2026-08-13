/**
 * Leaf lifecycle — the *time* half of "useful → bigger, unused → falls".
 *
 * Pure functions over a passed-in `now`, so a leaf's age is deterministic: the
 * same note renders identically in a test and in a browser. Two files under one
 * suite because they answer the same question — how the tree ages — from the two
 * directions the user asked for: leaves that wither and fall (`decay.mjs`), and
 * roots that thicken with the project on disk (`projsize.mjs`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, report, tmpdir, SRC } from './lib/harness.mjs';

const {
  decayConfig, witherFactor, hasFallen, isProtected, fallen, sweepFallen,
} = await import(`${SRC}/decay.mjs`);
const { countProjectFiles } = await import(`${SRC}/projsize.mjs`);

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-13T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

/** A note that was last authored `age` days ago, with knobs. */
const note = (age, over = {}) => ({
  id: `n${age}`,
  kind: 'reference',
  updated: daysAgo(age),
  created: daysAgo(age),
  reads: 0,
  pinned: false,
  archived: false,
  ...over,
});

const d = decayConfig({}); // defaults: wither 45d, fall 180d, grace 15d/read cap 120

/* ------------------------------------------------------------------ config -- */
ok('config: defaults present', d.enabled && d.witherAfterDays === 45 && d.fallAfterDays === 180);
ok('config: user override wins', decayConfig({ decay: { witherAfterDays: 10 } }).witherAfterDays === 10);
ok('config: protected kinds default', d.protectKinds.includes('gotcha') && d.protectKinds.includes('decision'));

/* ------------------------------------------------------------------ wither -- */
ok('wither: fresh leaf is full', witherFactor(note(3), d, NOW) === 0);
ok('wither: at the threshold, still full', witherFactor(note(45), d, NOW) === 0);
const half = witherFactor(note(45 + (180 - 45) / 2), d, NOW);
ok('wither: halfway rises to ~0.5', Math.abs(half - 0.5) < 0.02, String(half));
ok('wither: at fall, fully withered', witherFactor(note(180), d, NOW) === 1);
ok('wither: never exceeds 1', witherFactor(note(900), d, NOW) === 1);

ok('wither: pinned never withers', witherFactor(note(900, { pinned: true }), d, NOW) === 0);
ok('wither: gotcha never withers', witherFactor(note(900, { kind: 'gotcha' }), d, NOW) === 0);
ok('wither: decision never withers', witherFactor(note(900, { kind: 'decision' }), d, NOW) === 0);
ok('wither: archived reads as 0', witherFactor(note(900, { archived: true }), d, NOW) === 0);
ok('wither: disabled freezes the tree', witherFactor(note(900), decayConfig({ decay: { enabled: false } }), NOW) === 0);

// "used a lot" buys grace: recalls push the wither start later.
const stale = note(60); // 15 days past the 45-day wither start
ok('wither: an unread stale leaf has started', witherFactor(stale, d, NOW) > 0);
ok('wither: one read (15d grace) pulls it back to full', witherFactor({ ...stale, reads: 1 }, d, NOW) === 0);

/* ------------------------------------------------------------------- fall --- */
ok('fall: fresh leaf holds', hasFallen(note(30), d, NOW) === false);
ok('fall: just short holds', hasFallen(note(179), d, NOW) === false);
ok('fall: dormant past the threshold drops', hasFallen(note(181), d, NOW) === true);
ok('fall: pinned never falls', hasFallen(note(900, { pinned: true }), d, NOW) === false);
ok('fall: gotcha never falls', hasFallen(note(900, { kind: 'gotcha' }), d, NOW) === false);
ok('fall: already archived does not re-fall', hasFallen(note(900, { archived: true }), d, NOW) === false);
ok('fall: disabled keeps every leaf', hasFallen(note(900), decayConfig({ decay: { enabled: false } }), NOW) === false);

// Grace holds a much-read note up even well past the raw fall line, until the
// cap (120 days) is exhausted.
ok('fall: heavily-read note resists falling', hasFallen(note(220, { reads: 8 }), d, NOW) === false);
ok('fall: grace is capped, so it eventually drops', hasFallen(note(320, { reads: 8 }), d, NOW) === true);

/* --------------------------------------------------------------- protected -- */
ok('protected: pinned', isProtected(note(1, { pinned: true }), d) === true);
ok('protected: high-value kind', isProtected(note(1, { kind: 'gotcha' }), d) === true);
ok('protected: ordinary reference is not', isProtected(note(1), d) === false);

/* ----------------------------------------------------------------- fallen --- */
const flock = [
  note(300),                          // falls
  note(300, { pinned: true }),        // shielded
  note(300, { kind: 'decision' }),    // shielded
  note(10),                           // fresh
  note(300, { archived: true }),      // already down
];
const drop = fallen(flock, d, NOW);
ok('fallen: only the eligible one', drop.length === 1 && drop[0].id === flock[0].id, JSON.stringify(drop.map((n) => n.id)));

/* -------------------------------------------------------------- sweepFallen - */
{
  const entries = [note(300), note(320), note(340), note(10), note(300, { pinned: true })];
  const gone = [];
  const ctx = {
    cfg: {},
    allEntries: () => entries,
    store: { archive: (id) => gone.push(id) },
  };
  const ids = sweepFallen(ctx, { now: NOW });
  ok('sweep: archives every fallen leaf', gone.length === 3 && ids.length === 3, JSON.stringify(ids));
  ok('sweep: leaves the pinned and fresh alone', !gone.includes('n10'), JSON.stringify(gone));
}
{
  // A long-neglected tree can't turn one sweep into hundreds of writes.
  const many = Array.from({ length: 60 }, (_, i) => note(300, { id: `m${i}` }));
  const gone = [];
  const ctx = { cfg: {}, allEntries: () => many, store: { archive: (id) => gone.push(id) } };
  sweepFallen(ctx, { now: NOW, max: 25 });
  ok('sweep: bounded per run', gone.length === 25, String(gone.length));
}
{
  // Disabled decay never archives, whatever the ages.
  const gone = [];
  const ctx = { cfg: { decay: { enabled: false } }, allEntries: () => [note(900)], store: { archive: (id) => gone.push(id) } };
  ok('sweep: disabled archives nothing', sweepFallen(ctx, { now: NOW }).length === 0 && gone.length === 0);
}

/* ============================================================== projsize === */
/* Roots thicken with the real project on disk — count the source files, cheaply
 * and approximately, skipping the noise a person wouldn't call "the project". */
{
  const root = tmpdir('nt-projsize-');
  fs.writeFileSync(path.join(root, 'a.js'), 'a');
  fs.writeFileSync(path.join(root, 'b.js'), 'b');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'c.js'), 'c');
  fs.writeFileSync(path.join(root, 'src', 'd.js'), 'd');

  // Noise that must not inflate the count.
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'x');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');

  ok('projsize: counts source files, skips deps/.git/dotfiles', countProjectFiles(root, { now: 1 }) === 4, String(countProjectFiles(root, { now: 1 })));

  // Caching: a file added within the TTL isn't seen; a later `now` re-walks.
  fs.writeFileSync(path.join(root, 'e.js'), 'e');
  ok('projsize: cached within the TTL', countProjectFiles(root, { now: 2 }) === 4);
  ok('projsize: re-walks after the TTL', countProjectFiles(root, { now: 2 + 61_000 }) === 5);

  ok('projsize: a missing dir is simply small, never throws', countProjectFiles(path.join(root, 'nope'), { now: 1 }) === 0);
  ok('projsize: no dir at all is zero', countProjectFiles('', { now: 1 }) === 0);
}

report();
