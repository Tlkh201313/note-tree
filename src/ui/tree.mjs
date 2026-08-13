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
import { kindStyle, stageFor, KIND_WEIGHT, TREE } from '../theme.mjs';
import { decayConfig, witherFactor } from '../decay.mjs';

export const W = 1000;
// Room below the trunk base for roots. Kept deliberately shallow: at 190 the
// roots took a third of the frame on a young tree, and the eye went to an empty
// brown band instead of the leaves the page is about.
const SOIL = 92;
const CROWN = 150; // headroom above the newest branch
const MIN_SEG = 52;
const MAX_SEG = 150;
// The tallest a single bay between two tiers grows, reached when a branch is
// carrying a heavy frond of leaves. Deliberately above the plate's own segment
// (MAX_SEG): this is the room that lets a busy session's leaves splay up a long
// branch instead of piling onto a stub, so a heavy project reads as a *taller*
// tree rather than a more crowded one.
const TALL_SEG = 216;

/** A deterministic float in [0,1) from any string, with a salt for independence. */
function rand(id, salt = 0) {
  return (hash32(`${id}:${salt}`) % 100_000) / 100_000;
}

/**
 * Trunk centre-line.
 *
 * Dead straight, on purpose. An earlier version leaned on a sine wave to look
 * "grown", and it just looked unsteady — the drawing this is modelled on is a
 * botanical plate, where the stem is an axis and every branch is measured
 * against it. Symmetry is what makes the leaves legible as data.
 */
export function trunkX() {
  return W / 2;
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
export function layout(
  notes = [],
  { now = Date.now(), kindWeights = KIND_WEIGHT, decay = null, projectFiles = 0 } = {},
) {
  // Accept a raw `cfg.decay` (or nothing) and resolve it once against the defaults.
  const dcfg = decayConfig({ decay });
  const live = notes.filter((n) => !n.archived);
  const sessions = groupSessions(notes);
  const count = live.length;

  // Branches pair off onto shared nodes, so height is counted in tiers.
  const tiers = Math.max(1, Math.ceil(sessions.length / 2));

  // How tall a bay each tier gets — the lever you actually feel as "the tree
  // grew". A heavy session needs a taller bay so its frond of leaves splays out
  // along a longer branch instead of piling onto a stub, so the bay height is
  // set by the *busiest* branch (the most leaves on any one session), not by
  // the session count. A massive project therefore grows genuinely taller, with
  // room for every leaf, rather than the same height packed ever tighter.
  const busiest = sessions.reduce((m, s) => Math.max(m, s.notes.length), 1);
  const leafRoom = Math.min(TALL_SEG, MAX_SEG * 0.62 + busiest * 11); // ~104 .. 216
  // A long history still damps so it scrolls as a sane page rather than a mile
  // of empty trunk — but never below the room the busiest branch's leaves need.
  const packed = Math.min(MAX_SEG, 1000 / Math.max(1, Math.sqrt(tiers) * 2));
  const seg = Math.max(MIN_SEG, leafRoom, packed);
  // Vertical rhythm, in segments: bare stem to the lowest pair, then one
  // segment per tier, then the terminal shoot. BASE used to be 0.8 of a
  // segment, which on a two-branch tree read as a flagpole with twigs.
  const BASE = 0.45;
  const SHOOT = 0.7;
  const trunkSegs = BASE + (tiers - 1) + SHOOT;
  const height = Math.round(SOIL + trunkSegs * seg + CROWN);
  const baseY = height - SOIL;

  // A drawn stem, not a log. At the old weight it weighed in as a wedge and
  // the leaves read as an afterthought stuck to a plank.
  const thickness = 4.5 + Math.min(13, Math.sqrt(count) * 2.3);
  const topY = baseY - trunkSegs * seg;

  const trunk = { baseY, topY, thickness, path: trunkPath(baseY, topY, thickness, height) };

  const roots = buildRoots(baseY, thickness, height, count, projectFiles);
  const branches = [];
  const leaves = [];

  sessions.forEach((session, i) => {
    // Opposite pairs, the way the plate draws them: sessions 0 and 1 share a
    // node on the stem, 2 and 3 share the next one up. Time still runs upward,
    // and the silhouette comes out balanced instead of lopsided.
    const tier = Math.floor(i / 2);
    const side = i % 2 === 0 ? 1 : -1;
    const y = baseY - (tier + BASE) * seg;
    const r = rand(session.key);
    const x0 = trunkX();

    // Higher branches are shorter — the taper is most of what makes a shape
    // read as "tree" rather than "diagram".
    const taper = 0.58 + 0.42 * (1 - tier / Math.max(1, tiers));

    // How long this branch wants to be: as long as the session was busy, capped
    // against the plant's own height. Without that second cap a two-note sprout
    // grew branches wider than it was tall — a telegraph pole with wires.
    const wanted = Math.min(
      (150 + r * 40 + Math.min(200, session.notes.length * 22)) * taper,
      (baseY - topY) * 0.62,
    );

    // Elevation is measured above the horizon, never from vertical: from
    // vertical, `cos` flips sign partway through and throws a right-hand branch
    // out to the left, which is how a tree becomes a bush.
    //
    // The pair just under the apex has the least headroom, and the old code paid
    // for that by cutting their *length* — so the top of every tree was two
    // stubs with a bare stem running on above them. It now pays in *angle*: the
    // branch keeps its length and lies flatter to fit underneath. Lower tiers,
    // with room to spare, keep the steeper plate angle.
    const room = Math.max(30, y - topY - seg * 0.2);
    const want = (0.2 + rand(session.key, 4) * 0.035) * Math.PI; // ~36° to ~42°
    const elev = Math.max(0.075 * Math.PI, Math.min(want, Math.asin(Math.min(1, room / wanted))));
    const length = Math.min(
      wanted,
      // Stay on the canvas, and never climb into the branch above.
      (W / 2 - 70) / Math.cos(elev),
      room / Math.sin(elev),
    );

    const x1 = x0 + Math.cos(elev) * length * side;
    const y1 = y - Math.sin(elev) * length;
    // A shallow, even bow. Enough to look drawn by hand, not enough to wander.
    const curl = 0.16 * length;

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
    // A limb, not a wire. A uniform-width stroke reads as a rectangle laid on
    // the curve; a filled ribbon that leaves the trunk thick and tapers to a
    // fine shoot reads as something that grew. `d` (the centre line) stays, for
    // the tangent maths the leaves hang off and for older exports.
    const baseW = Math.max(3.2, thickness * 0.5 * taper);
    branch.fill = ribbon(branch, baseW, 1.1);
    branches.push(branch);

    const n = session.notes.length;
    // Leaves in opposite pairs down the branch, terminal leaf at the tip —
    // the arrangement in the drawing. Pair p sits at one point on the stem,
    // one leaf either side of it.
    const pairs = Math.max(1, Math.ceil(n / 2));
    session.notes.forEach((note, k) => {
      const pair = Math.floor(k / 2);
      const leafSide = k % 2 === 0 ? 1 : -1;
      // Start well clear of the stem — a leaf splayed inward from t=0.36 landed
      // on the trunk — and run to the tip, so the newest note on a session is
      // the terminal leaf.
      const t = pairs === 1 ? 0.84 : 0.44 + (pair / (pairs - 1)) * 0.52;
      const p = pointOnQuad(branch, t);

      // Splay outward from the branch: along its tangent, swung off to one
      // side. This is what makes a row of leaves look like a frond instead of
      // beads on a string.
      const tan = tangentOnQuad(branch, t);
      const tanLen = Math.hypot(tan.x, tan.y) || 1;
      const ux = tan.x / tanLen;
      const uy = tan.y / tanLen;
      const nx = -uy * leafSide * side;
      const ny = ux * leafSide * side;

      const ageDays = Math.max(0, (now - (Date.parse(note.updated || note.created) || now)) / 86_400_000);
      const style = kindStyle(note.kind);

      // Leaf size *is* usefulness, so the tree reads at a glance: the biggest
      // leaves are the notes worth the most. A note earns size three ways, all
      // deterministic, none random —
      //   kind    a gotcha outgrows a bookmark (same weights the seed ranks by)
      //   reads   a note you keep recalling has proven itself
      //   pinned  you said it always matters
      // An unread `reference` is the smallest thing on the tree; a pinned,
      // often-recalled `gotcha` the largest. Archived leaves shrink toward the
      // floor of the range as they fall out of use.
      const useful =
        ((kindWeights[note.kind] ?? 0) / 3) * 3.4 +
        Math.min(2.8, Math.log2(1 + Math.max(0, note.reads || 0)) * 1.35) +
        (note.pinned ? 2.2 : 0);
      // Then the time half: a note left unrecalled withers, its leaf shrinking
      // toward the floor and fading, until it finally falls (archived elsewhere).
      // Pinned and protected kinds never wither — `witherFactor` returns 0 for
      // them — so the biggest leaves stay big however long they sit.
      const wither = witherFactor(note, dcfg, now);
      const FLOOR = 3.6;
      const full = 4.4 + useful;
      const rad = note.archived ? 3.8 + useful * 0.5 : full - (full - FLOOR) * 0.6 * wither;

      // Sit the leaf clear of the branch it hangs from, along that normal.
      const off = rad * 1.5 + branch.width * 0.5;
      const dirX = ux * 0.5 + nx * 0.9;
      const dirY = uy * 0.5 + ny * 0.9;

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
        // Archived leaves droop: still attached, visibly done. The old drop was
        // twice this and read as a leaf that had come off the tree entirely.
        x: fmt(p.x + nx * off),
        y: fmt(p.y + ny * off + (note.archived ? 11 + rand(note.id, 4) * 9 : 0)),
        r: rad,
        // Withering fades a leaf as well as shrinking it, so a note on its way
        // out reads as dimming before it drops — not a sudden disappearance.
        opacity: note.archived ? 0.42 : Math.max(0.4, (1 - ageDays / 400) - 0.4 * wither),
        // A leaf's own axis points up; rotate it onto the splay direction.
        angle: fmt((Math.atan2(dirX, -dirY) * 180) / Math.PI),
        // Where it attaches, so the drawing can grow it a stalk.
        stemX: fmt(p.x),
        stemY: fmt(p.y),
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
  // Crop, but never magnify past this: below it the trunk fills the screen like
  // a close-up of bark, which is the opposite of a specimen drawing. It was 760
  // — wide enough that a four-leaf sprout sat marooned in the middle of an
  // empty field.
  const MIN_W = 520;
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
    // Near-parallel sides, closing only in the last stretch. A power curve
    // flared the base into an obelisk; a plate's stem barely tapers at all.
    // Closes to a fine tip rather than stopping square: the apex is a growing
    // shoot, and a flat-topped post is the one thing that never reads as alive.
    const w = (thickness * (1 - 0.84 * (i / steps) ** 1.5) + 1.1) / 2;
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

/**
 * Roots, mirroring the canopy.
 *
 * Drawn as a fan of fine hairs rather than a few thick prongs: in the plate
 * the root system is the same weight of line as the twigs, which is what makes
 * the two halves of the drawing balance. More notes, denser hold.
 */
function buildRoots(baseY, thickness, height, count, files = 0) {
  // Two things feed the roots. The notes give them their base vigour — a sprout
  // has a sprout's roots, or fixed-size roots swamp a four-leaf plant. The size
  // of the codebase on disk then makes them thicker, deeper and more numerous:
  // a tree standing in a big project is more firmly anchored than one in an
  // empty folder. `files` is 0 for a bare export or the hero, so those trees
  // keep the note-only shape and stay byte-identical.
  const soil = Math.min(1, Math.log10(1 + Math.max(0, files)) / 4); // 0 .. 1 (~10k files)
  const noteVigour = 0.5 + 0.5 * Math.min(1, Math.sqrt(count) / 4); // 0.5 .. 1
  const vigour = noteVigour * (1 + 0.85 * soil); // up to ~1.85 under a large repo
  const n = 5 + Math.min(6, Math.floor(Math.sqrt(count) * 1.5)) + Math.round(soil * 3);
  const x0 = trunkX();
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rand(`root-${i}`, n);
    // Fan evenly from one side to the other, so the spread is even rather than
    // clumped — deterministic variation only nudges each hair off its slot.
    const slot = n === 1 ? 0.5 : i / (n - 1);
    const dir = (slot - 0.5) * 2; // -1 .. 1
    // Shorter reach than before: straight lines this long fanned into a
    // starburst. A root should look like it turned as it went.
    const spread = dir * (28 + r * 62) * vigour;
    // Scaled to SOIL rather than fixed, and clamped just short of the canvas
    // floor, so however vigorous the roots get they never run off the picture.
    // The centre hairs run deepest — that's the taproot.
    const depth = Math.min(SOIL * 0.94, SOIL * (0.34 + (1 - Math.abs(dir)) * 0.46 + r * 0.1) * vigour);
    // The same quadratic as before, but held as an object so it can be both a
    // centre line and a tapering ribbon — a root should thin as it reaches, the
    // mirror of the branches above the soil rather than a constant-width wire.
    const quad = {
      x0,
      y0: baseY - 4,
      cx: x0 + spread * 0.14,
      cy: baseY + depth * 0.64,
      x1: x0 + spread,
      y1: baseY + depth,
    };
    // Thicker in a bigger project — the visible "stronger roots". The tip still
    // tapers to a fine point, so it's the hold at the trunk that grows, not the
    // whole hair swelling into a wedge.
    const width = Math.max(1.2, thickness * 0.24 * (1 - Math.abs(dir) * 0.4)) * (1 + 0.75 * soil);
    out.push({
      d: quadPath(quad),
      fill: ribbon(quad, width, 0.5),
      width,
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

/** Derivative of the quadratic — the direction the branch is heading at `t`. */
function tangentOnQuad(b, t) {
  return {
    x: 2 * (1 - t) * (b.cx - b.x0) + 2 * t * (b.x1 - b.cx),
    y: 2 * (1 - t) * (b.cy - b.y0) + 2 * t * (b.y1 - b.cy),
  };
}

export function quadPath(b) {
  return `M ${fmt(b.x0)} ${fmt(b.y0)} Q ${fmt(b.cx)} ${fmt(b.cy)} ${fmt(b.x1)} ${fmt(b.y1)}`;
}

/**
 * A tapering filled outline along a quadratic — a limb or a root, thick at the
 * base and drawn to a fine tip.
 *
 * The two sides are the centre line offset by the half-width along the normal,
 * so the ribbon hugs the same curve the leaves are placed on. Width eases from
 * `wBase` to `wTip` with a gentle power curve: full where it joins its parent,
 * quick to narrow after that, which is how a real branch tapers.
 */
function ribbon(q, wBase, wTip, steps = 18) {
  const L = [];
  const R = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = pointOnQuad(q, t);
    const tan = tangentOnQuad(q, t);
    const len = Math.hypot(tan.x, tan.y) || 1;
    const nx = -tan.y / len;
    const ny = tan.x / len;
    const half = (wTip + (wBase - wTip) * (1 - t) ** 0.7) / 2;
    L.push([p.x + nx * half, p.y + ny * half]);
    R.push([p.x - nx * half, p.y - ny * half]);
  }
  const d = [`M ${fmt(L[0][0])} ${fmt(L[0][1])}`];
  for (let i = 1; i <= steps; i++) d.push(`L ${fmt(L[i][0])} ${fmt(L[i][1])}`);
  for (let i = steps; i >= 0; i--) d.push(`L ${fmt(R[i][0])} ${fmt(R[i][1])}`);
  d.push('Z');
  return d.join(' ');
}

/** Two decimals is well under one screen pixel, and halves the file size. */
function fmt(n) {
  return Math.round(n * 100) / 100;
}
