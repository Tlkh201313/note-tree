/**
 * One palette, two renderers.
 *
 * The terminal and the tree have to agree: a `gotcha` is amber in `note-tree
 * list` and amber on the leaf you click in the browser. Defining it once is the
 * only way that stays true as both sides change.
 */

import { KINDS } from './config.mjs';

/**
 * `hex` drives the leaves, `ansi` the terminal, `glyph` marks kind in list
 * output, `ascii` covers terminals that would render the glyph as a box.
 */
export const KIND_STYLE = {
  decision: { hex: '#7dd3fc', ansi: 36, glyph: '◆', ascii: '*', label: 'decision' },
  convention: { hex: '#93c5fd', ansi: 34, glyph: '▤', ascii: '=', label: 'convention' },
  gotcha: { hex: '#fbbf24', ansi: 33, glyph: '▲', ascii: '!', label: 'gotcha' },
  architecture: { hex: '#c4b5fd', ansi: 35, glyph: '⬢', ascii: '#', label: 'architecture' },
  preference: { hex: '#86efac', ansi: 32, glyph: '●', ascii: '+', label: 'preference' },
  reference: { hex: '#94a3b8', ansi: 90, glyph: '▸', ascii: '>', label: 'reference' },
  todo: { hex: '#fca5a5', ansi: 31, glyph: '○', ascii: 'o', label: 'todo' },
};

const FALLBACK = { hex: '#94a3b8', ansi: 90, glyph: '·', ascii: '.', label: 'note' };

export function kindStyle(kind) {
  return KIND_STYLE[kind] || FALLBACK;
}

/** The tree's own colours, shared by the web UI and the ASCII tree in the CLI. */
export const TREE = {
  trunk: '#8b6f47',
  trunkDark: '#6b5537',
  branch: '#a1866b',
  soil: '#3f3527',
  sky: '#0b1220',
  glow: '#fde68a',
  archived: '#7c6a58',
  pinned: '#fde047',
};

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
