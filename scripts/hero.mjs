/**
 * Render docs/hero.svg — the README's picture of the product.
 *
 * Two panels, both generated rather than drawn: the *real* tree layout from
 * `src/ui/tree.mjs`, and the *real* seed block a session would receive, from
 * the same sample notes as `note-tree demo`. So the picture can't drift away
 * from the thing it advertises — change the geometry or the renderer, re-run
 * this, and the README updates.
 *
 *   node scripts/hero.mjs            # docs/hero.svg
 *   node scripts/hero.mjs --notes 18 --out docs/hero.svg
 *
 * The animated hero (a tree growing leaf by leaf) is recorded separately — see
 * docs/media.md — and replaces this file in the README when it exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
// 18 is the size of the sample corpus: more than that repeats titles, which
// would advertise a tree full of duplicates.
const COUNT = Number(arg('notes', 18));
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'hero.svg')));

// A throwaway store: the hero must never render someone's actual memory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-hero-'));
process.env.NOTE_TREE_HOME = tmp;
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const SRC = pathToFileURL(path.join(REPO, 'src')).href;
const { openContext } = await import(`${SRC}/context.mjs`);
const { layout } = await import(`${SRC}/ui/tree.mjs`);
const { TREE, kindStyle, KIND_LEGEND } = await import(`${SRC}/theme.mjs`);
const { sampleNotes } = await import(`${SRC}/cli/cmd/view.mjs`);

const ctx = openContext({ cwd: path.join(tmp, 'orchard-api'), agent: 'claude' });
ctx.store.ensure();
for (const note of sampleNotes(COUNT)) {
  try {
    ctx.write(note, { force: true });
  } catch {
    /* one unusable sample shouldn't cost us the picture */
  }
}

const notes = ctx.allEntries();
const seed = ctx.seed();
// `now` is pinned to the newest note so re-running produces a byte-identical
// file rather than a diff full of shifted opacities.
const now = Math.max(...notes.map((n) => Date.parse(n.updated || n.created) || 0));
const L = layout(notes, { now });

/* ------------------------------------------------------------------------ */

const W = 1240;
const H = 700;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Two decimals is far under a pixel, and keeps the committed file readable.
const n2 = (n) => Math.round(n * 100) / 100;
const out = [];
const push = (...lines) => out.push(...lines);

push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="note-tree: ${L.counts.live} saved notes drawn as leaves on a tree, and the ${seed.tokens}-token block a session receives">`);
push(`<title>note-tree — ${L.counts.live} notes across ${L.counts.sessions} sessions become ${seed.counts.rendered} lines and ~${seed.tokens} tokens per session</title>`);
push('<defs>');
push('<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262624"/><stop offset="1" stop-color="#201f1e"/></linearGradient>');
push(`<radialGradient id="glow" cx="0.5" cy="0.5"><stop offset="0" stop-color="${TREE.glow}" stop-opacity="0.18"/><stop offset="1" stop-color="${TREE.glow}" stop-opacity="0"/></radialGradient>`);
push('</defs>');
push(`<rect width="${W}" height="${H}" rx="14" fill="url(#sky)"/>`);

/* ------------------------------------------------------------- headline -- */

push(`<text x="34" y="52" font-family="${SANS}" font-size="27" font-weight="600" fill="#f5f4ef">🌳 note-tree</text>`);
push(`<text x="34" y="78" font-family="${SANS}" font-size="15" fill="#b5b2a9">Memory that grows, not memory that bloats.</text>`);

/* ----------------------------------------------------------- tree panel -- */

const PANEL = { x: 26, y: 104, w: 372, h: 560 };
push(`<rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" rx="12" fill="#2e2e2c" stroke="#3b3a37"/>`);
push(`<svg x="${PANEL.x + 8}" y="${PANEL.y + 30}" width="${PANEL.w - 16}" height="${PANEL.h - 66}" viewBox="0 0 ${L.width} ${L.height}" preserveAspectRatio="xMidYMax meet">`);
const crown = L.leaves.reduce((min, l) => Math.min(min, l.y), L.height);
push(`<ellipse cx="${L.width / 2}" cy="${Math.round((crown + L.ground) / 2)}" rx="${Math.round(L.width * 0.4)}" ry="${Math.round((L.ground - crown) * 0.62)}" fill="url(#glow)"/>`);
push(`<rect x="0" y="${L.ground}" width="${L.width}" height="${L.height - L.ground}" fill="${TREE.soil}" opacity="0.5"/>`);
for (const r of L.roots) push(`<path d="${r.d}" stroke="${TREE.trunkDark}" stroke-width="${n2(r.width)}" fill="none" stroke-linecap="round" opacity="0.85"/>`);
push(`<path d="${L.trunk.path}" fill="${TREE.trunk}"/>`);
for (const b of L.branches) push(`<path d="${b.d}" stroke="${TREE.branch}" stroke-width="${n2(b.width)}" fill="none" stroke-linecap="round"/>`);
for (const leaf of L.leaves) {
  push(
    `<g transform="translate(${n2(leaf.x)} ${n2(leaf.y)}) rotate(${leaf.angle})" opacity="${n2(leaf.opacity)}">` +
      `<ellipse rx="${n2(leaf.r * 1.6)}" ry="${n2(leaf.r)}" fill="${leaf.color}"/>` +
      (leaf.pinned ? `<circle r="${n2(leaf.r * 0.42)}" fill="${TREE.pinned}"/>` : '') +
      `<title>${esc(leaf.title)}</title>` +
      '</g>',
  );
}
push('</svg>');
push(`<text x="${PANEL.x + 14}" y="${PANEL.y + 22}" font-family="${MONO}" font-size="12" fill="#85837b">one leaf per note · one branch per session</text>`);
push(`<text x="${PANEL.x + 14}" y="${PANEL.y + PANEL.h - 14}" font-family="${MONO}" font-size="12" fill="#b5b2a9">${L.counts.live} notes · ${L.counts.sessions} sessions · ${L.stage}</text>`);

/* ----------------------------------------------------------- seed panel -- */

const SEED = { x: 420, y: 104, w: 794, h: 560 };
push(`<rect x="${SEED.x}" y="${SEED.y}" width="${SEED.w}" height="${SEED.h}" rx="12" fill="#2e2e2c" stroke="#3b3a37"/>`);
push(`<text x="${SEED.x + 16}" y="${SEED.y + 24}" font-family="${MONO}" font-size="12" fill="#85837b">what the next session actually receives — every session, in every agent</text>`);

const CHAR = 6.62; // measured advance of the mono stack at 11px
const MAX_CHARS = Math.floor((SEED.w - 34) / CHAR);
const clip = (s) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS - 1) + '…' : s);

let y = SEED.y + 52;
const line = (x, text, fill, opts = '') => push(`<text x="${x}" y="${y}" font-family="${MONO}" font-size="11" fill="${fill}"${opts}>${esc(text)}</text>`);

for (const raw of seed.text.split('\n')) {
  if (y > SEED.y + SEED.h - 46) {
    line(SEED.x + 16, '…', '#6f6d66');
    break;
  }
  const note = raw.match(/^(\w+) (\w+) (\S+) (.*)$/);
  if (raw.startsWith('<note-tree-memory') || raw.startsWith('</note-tree-memory')) {
    line(SEED.x + 16, raw, '#d97757');
  } else if (raw.startsWith('## ')) {
    y += 6;
    line(SEED.x + 16, clip(raw), '#f5f4ef', ' font-weight="600"');
  } else if (note) {
    const [, id, kind, age, rest] = note;
    const style = kindStyle(kind);
    const head = `${id} ${kind} ${age} `;
    line(SEED.x + 16, id, '#6f6d66');
    push(`<text x="${n2(SEED.x + 16 + (id.length + 1) * CHAR)}" y="${y}" font-family="${MONO}" font-size="11" fill="${style.hex}">${esc(kind)}</text>`);
    push(`<text x="${n2(SEED.x + 16 + (id.length + kind.length + 2) * CHAR)}" y="${y}" font-family="${MONO}" font-size="11" fill="#6f6d66">${esc(age)}</text>`);
    push(`<text x="${n2(SEED.x + 16 + head.length * CHAR)}" y="${y}" font-family="${MONO}" font-size="11" fill="#d8d5cc">${esc(clip(rest).slice(0, MAX_CHARS - head.length))}</text>`);
  } else {
    line(SEED.x + 16, clip(raw), '#85837b');
  }
  y += 17;
}

push(
  `<text x="${SEED.x + 16}" y="${SEED.y + SEED.h - 16}" font-family="${MONO}" font-size="12" fill="#b5b2a9">` +
    `${seed.counts.rendered} notes · ${seed.chars} chars · ~${seed.tokens} tokens · ranked and hard-capped` +
    '</text>',
);

/* ---------------------------------------------------------------- legend -- */

const seen = new Set(L.leaves.map((l) => l.kind));
let lx = 420;
for (const k of KIND_LEGEND.filter((k) => seen.has(k.kind))) {
  push(`<ellipse cx="${n2(lx)}" cy="${H - 18}" rx="6" ry="4" fill="${k.hex}"/>`);
  push(`<text x="${n2(lx + 12)}" y="${H - 14}" font-family="${MONO}" font-size="11" fill="#85837b">${k.label}</text>`);
  lx += 26 + k.label.length * 6.6;
}
push(`<text x="34" y="${H - 14}" font-family="${MONO}" font-size="11" fill="#85837b">0 dependencies</text>`);

push('</svg>');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  `${path.relative(REPO, OUT)} — ${L.counts.live} leaves across ${L.counts.sessions} branches, ` +
    `seed ${seed.counts.rendered} notes / ~${seed.tokens} tokens, ${(out.join('\n').length / 1024).toFixed(0)} KB`,
);
