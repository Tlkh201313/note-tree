/**
 * Tree geometry.
 *
 * Pure functions: notes in, coordinates out. No DOM, no fs, no config beyond
 * what's passed. The live server and the static export both call this, so the
 * tree you see in the browser and the tree in an exported file are the same
 * tree — and it can be unit-tested without a browser.
 *
 * The one rule everything else follows: **layout is deterministic**. Every
 * position derives from a hash of an id, never from `Math.random()` and never
 * from array order beyond time. A leaf that was on the left yesterday is on the
 * left today, so the tree becomes a place you can remember your way around.
 */

import { hash32 } from '../paths.mjs';
import { kindStyle, stageFor, TREE } from '../theme.mjs';

export const W = 1000;
// Room below the trunk base for roots. Kept deliberately shallow: at 190 the
// roots took a third of the frame on a young tree, and the eye went to an empty
// brown band instead of the leaves the page is about.
const SOIL = 92;
const CROWN = 150; // headroom above the newest branch
const MIN_SEG = 52;
const MAX_SEG = 150;

/** A deterministic float in [0,1) from any string, with a salt for independence. */
function rand(id, salt = 0) {
  return (hash32(`${id}:${salt}`) % 100_000) / 100_000;
}

/** Trunk centre-line: a slow sine, so the tree leans like a thing that grew. */
export function trunkX(y, height) {
  const t = (height - y) / Math.max(1, height);
  return W / 2 + Math.sin(t * 2.4) * 26 * Math.min(1, t * 1.6);
}

/**
 * Sessions, oldest first.
 *
 * Notes written outside any session (CLI, imports) share a synthetic session
 * bucket per day, so a week of terminal notes reads as a week of growth rather
 * than one impossible branch.
 */
export function groupSessions(notes) {
  const buckets = new Map();
  for (const n of notes) {
    const when = Date.parse(n.created || n.updated || 0) || 0;
    const key = n.session || `day-${new Date(when).toISOString().slice(0, 10)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { key, notes: [], first: when, last: when, agents: new Set() }));
    b.notes.push(n);
    b.first = Math.min(b.first, when);
    b.last = Math.max(b.last, when);
    if (n.agent) b.agents.add(n.agent);
  }
  return [...buckets.values()]
    .sort((a, b) => a.first - b.first)
    .map((b) => ({ ...b, agents: [...b.agents], notes: b.notes.sort((x, y) => Date.parse(x.created) - Date.parse(y.created)) }));
}

/**
 * Full layout.
 *
 * @param notes  index entries (never bodies — the tree is metadata only)
 * @param opts.now  for stable snapshots in tests
 * @returns `{ width, height, stage, trunk, roots, branches, leaves, ground }`
 */
export function layout(notes = [], { now = Date.now() } = {}) {
  const live = notes.filter((n) => !n.archived);
  const sessions = groupSessions(notes);
  const count = live.length;

  // Segments compress as the tree grows, so a hundred sessions still fit on a
  // page you can scroll rather than a mile of empty trunk.
  const seg = Math.max(MIN_SEG, Math.min(MAX_SEG, 1400 / Math.max(1, Math.sqrt(sessions.length) * 2)));
  const height = Math.round(SOIL + CROWN + Math.max(1, sessions.length) * seg);
  const baseY = height - SOIL;

  const thickness = 12 + Math.min(46, Math.sqrt(count) * 7);
  const topY = height - SOIL - sessions.length * seg;

  const trunk = {
    baseY,
    topY: Math.max(CROWN * 0.6, topY - seg * 0.55),
    thickness,
    path: trunkPath(baseY, Math.max(CROWN * 0.6, topY - seg * 0.55), thickness, height),
  };

  const roots = buildRoots(baseY, thickness, height, count);
  const branches = [];
  const leaves = [];

  sessions.forEach((session, i) => {
    const y = baseY - (i + 0.65) * seg;
    const side = i % 2 === 0 ? 1 : -1;
    const r = rand(session.key);
    const x0 = trunkX(y, height);

    // Higher branches are shorter — the taper is most of what makes a shape
    // read as "tree" rather than "diagram".
    const taper = 0.55 + 0.45 * (1 - i / Math.max(1, sessions.length));

    // Elevation above the horizon, never an angle from vertical: measured from
    // vertical, `cos` changes sign partway through the range and throws a
    // right-hand branch out to the left, which is how a tree becomes a bush.
    // Salted separately from the length so a long branch isn't also a steep one.
    const elev = (0.11 + rand(session.key, 4) * 0.2) * Math.PI; // ~20° to ~56°
    const length = Math.min(
      (170 + r * 110 + Math.min(140, session.notes.length * 20)) * taper,
      // Stay on the canvas, and never climb so far that a branch buries the two
      // above it — sessions have to stay legible as separate growth.
      (W / 2 - 60) / Math.cos(elev),
      (seg * 1.7) / Math.sin(elev),
    );

    const x1 = x0 + Math.cos(elev) * length * side;
    const y1 = y - Math.sin(elev) * length;
    const curl = (0.22 + rand(session.key, 1) * 0.3) * length;

    const branch = {
      id: session.key,
      index: i,
      side,
      x0,
      y0: y,
      x1,
      y1,
      width: Math.max(2, (thickness * 0.32) * taper),
      // Quadratic control point pushed along the normal: the curl.
      cx: (x0 + x1) / 2 - side * curl * 0.35,
      cy: (y + y1) / 2 - curl * 0.28,
      count: session.notes.length,
      agents: session.agents,
      first: session.first,
      last: session.last,
    };
    branch.d = quadPath(branch);
    branches.push(branch);

    const n = session.notes.length;
    session.notes.forEach((note, k) => {
      // Leaves start a third of the way out so the branch reads as a branch.
      const t = n === 1 ? 0.74 : 0.34 + (k / (n - 1)) * 0.62;
      const p = pointOnQuad(branch, t);
      const jitterA = rand(note.id, 2) - 0.5;
      const jitterB = rand(note.id, 3) - 0.5;
      const spread = 12 + Math.min(26, n * 2);

      const ageDays = Math.max(0, (now - (Date.parse(note.updated || note.created) || now)) / 86_400_000);
      const style = kindStyle(note.kind);

      leaves.push({
        id: note.id,
        title: note.title,
        // Bodies stay out of the layout — they're the bulk — but the one-line
        // description is what makes the sidebar useful the instant it opens.
        desc: note.desc || '',
        kind: note.kind,
        scope: note.scope,
        session: session.key,
        agent: note.agent || null,
        created: note.created,
        updated: note.updated || note.created,
        tags: note.tags || [],
        pinned: Boolean(note.pinned),
        archived: Boolean(note.archived),
        reads: note.reads || 0,
        color: note.archived ? TREE.archived : style.hex,
        // Archived leaves hang: still there, visibly fallen.
        x: p.x + jitterA * spread,
        y: p.y + jitterB * spread * 0.7 + (note.archived ? 30 + rand(note.id, 4) * 26 : 0),
        r: (note.archived ? 4.2 : 5.4) + Math.min(4.6, Math.sqrt(note.reads || 0) * 1.9) + (note.pinned ? 1.2 : 0),
        opacity: note.archived ? 0.42 : Math.max(0.55, 1 - ageDays / 400),
        angle: Math.round((rand(note.id, 5) * 90 - 45) * 10) / 10,
        branch: session.key,
        t,
      });
    });
  });

  return {
    width: W,
    height,
    seg,
    stage: stageFor(count),
    counts: { notes: notes.length, live: count, archived: notes.length - count, sessions: sessions.length },
    ground: baseY,
    frame: fitFrame(trunk, branches, leaves, roots, height),
    trunk,
    roots,
    branches,
    leaves,
  };
}

/**
 * The window to actually show.
 *
 * The canvas is a fixed 1000 wide because the geometry is easier to reason
 * about that way, but a young tree only occupies the middle third of it — and
 * rendering the whole canvas leaves it marooned in empty space. So the view is
 * cropped to what was drawn, with enough padding to breathe.
 *
 * Two guards: never zoom past MIN_W (three leaves shouldn't fill a monitor),
 * and never extend past the canvas edges (there's nothing out there).
 */
function fitFrame(trunk, branches, leaves, roots, height) {
  const MIN_W = 620;
  const PAD_X = 74;
  const PAD_TOP = 54;

  const xs = [];
  const ys = [];
  const add = (x, y) => {
    if (Number.isFinite(x)) xs.push(x);
    if (Number.isFinite(y)) ys.push(y);
  };

  const baseX = trunkX(trunk.baseY, height);
  add(baseX - trunk.thickness, trunk.baseY);
  add(baseX + trunk.thickness, trunk.topY);
  for (const b of branches) {
    add(b.x0, b.y0);
    add(b.x1, b.y1);
    add(b.cx, b.cy);
  }
  // A leaf is a shape around its point, not the point — pad by its radius.
  for (const l of leaves) {
    add(l.x - l.r * 2.2, l.y - l.r * 2.2);
    add(l.x + l.r * 2.2, l.y + l.r * 2.2);
  }
  for (const r of roots) add(r.x, r.y);

  const minX = Math.min(...xs) - PAD_X;
  const maxX = Math.max(...xs) + PAD_X;
  const w = Math.min(W, Math.max(MIN_W, maxX - minX));
  const centre = (minX + maxX) / 2;
  const x = Math.min(W - w, Math.max(0, centre - w / 2));

  // The bottom is always the soil line: roots are the anchor of the image, and
  // a frame that floated above them would look like the tree was cut off.
  const y = Math.max(0, Math.min(...ys) - PAD_TOP);
  return { x: fmt(x), y: fmt(y), w: fmt(w), h: fmt(height - y) };
}

/** Trunk as a closed tapering outline rather than a stroked line. */
function trunkPath(baseY, topY, thickness, height) {
  const steps = 14;
  const left = [];
  const right = [];
  for (let i = 0; i <= steps; i++) {
    const y = baseY - ((baseY - topY) * i) / steps;
    const w = (thickness * (1 - i / steps) ** 0.85 + 3.4) / 2;
    const x = trunkX(y, height);
    left.push([x - w, y]);
    right.push([x + w, y]);
  }
  const d = [
    `M ${fmt(left[0][0])} ${fmt(left[0][1])}`,
    ...left.slice(1).map(([x, y]) => `L ${fmt(x)} ${fmt(y)}`),
    ...right.reverse().map(([x, y]) => `L ${fmt(x)} ${fmt(y)}`),
    'Z',
  ];
  return d.join(' ');
}

/** Roots mirror the canopy: more notes, deeper hold. */
function buildRoots(baseY, thickness, height, count) {
  const n = 3 + Math.min(4, Math.floor(Math.sqrt(count)));
  const x0 = trunkX(baseY, height);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rand(`root-${i}`, n);
    const side = i % 2 === 0 ? 1 : -1;
    const spread = (40 + r * 150) * side;
    // Scaled to SOIL rather than fixed, so no root ever runs off the canvas.
    const depth = SOIL * (0.3 + r * 0.5);
    out.push({
      d: `M ${fmt(x0)} ${fmt(baseY - 4)} Q ${fmt(x0 + spread * 0.4)} ${fmt(baseY + depth * 0.45)} ${fmt(x0 + spread)} ${fmt(baseY + depth)}`,
      width: Math.max(1.4, (thickness * 0.22) * (1 - i / (n + 1))),
      // Kept as numbers too, so the frame can be fitted without re-parsing `d`.
      x: x0 + spread,
      y: baseY + depth,
    });
  }
  return out;
}

function pointOnQuad(b, t) {
  const u = 1 - t;
  return {
    x: u * u * b.x0 + 2 * u * t * b.cx + t * t * b.x1,
    y: u * u * b.y0 + 2 * u * t * b.cy + t * t * b.y1,
  };
}

export function quadPath(b) {
  return `M ${fmt(b.x0)} ${fmt(b.y0)} Q ${fmt(b.cx)} ${fmt(b.cy)} ${fmt(b.x1)} ${fmt(b.y1)}`;
}

/** Two decimals is well under one screen pixel, and halves the file size. */
function fmt(n) {
  return Math.round(n * 100) / 100;
}
