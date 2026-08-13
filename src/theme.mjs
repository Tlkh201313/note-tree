/**
 * One palette, two renderers.
 *
 * The terminal and the tree have to agree: a `gotcha` is amber in `note-tree
 * list` and amber on the leaf you click in the browser. Defining it once is the
 * only way that stays true as both sides change.
 */

import { KINDS } from './config.mjs';

/**
 * `hex` drives the leaves on a dark page, `light` the same leaf on a light one,
 * `ansi` the terminal, `glyph` marks kind in list output, and `ascii` covers
 * terminals that would render the glyph as a box.
 *
 * Both hexes are muted on purpose. Seven saturated colours on one page reads as
 * a chart; these are pigments — enough separation to tell a gotcha from a
 * decision at a glance, not enough to shout.
 */
export const KIND_STYLE = {
  decision: { hex: '#86b8d9', light: '#3f7ea6', ansi: 36, glyph: '◆', ascii: '*', label: 'decision' },
  convention: { hex: '#9db4d8', light: '#506d99', ansi: 34, glyph: '▤', ascii: '=', label: 'convention' },
  gotcha: { hex: '#e3a857', light: '#b0741c', ansi: 33, glyph: '▲', ascii: '!', label: 'gotcha' },
  architecture: { hex: '#b7a3dd', light: '#7658a5', ansi: 35, glyph: '⬢', ascii: '#', label: 'architecture' },
  preference: { hex: '#94c9a3', light: '#4b8a63', ansi: 32, glyph: '●', ascii: '+', label: 'preference' },
  reference: { hex: '#a3a096', light: '#7c7970', ansi: 90, glyph: '▸', ascii: '>', label: 'reference' },
  todo: { hex: '#e39182', light: '#b4553f', ansi: 31, glyph: '○', ascii: 'o', label: 'todo' },
};

const FALLBACK = { hex: '#a3a096', light: '#7c7970', ansi: 90, glyph: '·', ascii: '.', label: 'note' };

export function kindStyle(kind) {
  return KIND_STYLE[kind] || FALLBACK;
}

/** The tree's own colours, shared by the web UI and the ASCII tree in the CLI. */
export const TREE = {
  trunk: '#9a8163',
  trunkDark: '#75604a',
  branch: '#ab9375',
  soil: '#332a1f',
  sky: '#262624',
  glow: '#f0d9ab',
  archived: '#8a7f70',
  pinned: '#e0b341',
};

/**
 * The kind palette as CSS custom properties, one block per theme.
 *
 * The page could hard-code these, but then a new kind — or a colour someone
 * disagrees with — would have to be changed in two places and would silently
 * disagree with `note-tree list` until someone noticed. Generating them keeps
 * the terminal and the browser the same product.
 */
export function kindCssVars() {
  const line = (pick) =>
    Object.entries(KIND_STYLE)
      .map(([kind, style]) => `--k-${kind}: ${pick(style)};`)
      .join('\n  ');
  return {
    night: line((s) => s.hex),
    day: line((s) => s.light),
  };
}

/** Growth stages, so the trunk and canopy scale with what you've actually saved. */
export const STAGES = [
  { at: 0, name: 'seed' },
  { at: 1, name: 'sprout' },
  { at: 5, name: 'sapling' },
  { at: 15, name: 'young' },
  { at: 40, name: 'mature' },
  { at: 100, name: 'ancient' },
];

export function stageFor(count) {
  let stage = STAGES[0];
  for (const s of STAGES) if (count >= s.at) stage = s;
  return stage.name;
}

/** Legend rows for the UI and `note-tree help kinds`. */
export const KIND_LEGEND = KINDS.map((k) => ({ kind: k, ...kindStyle(k) }));
