/**
 * The note schema: identity, validation, and Markdown frontmatter (de)serialisation.
 *
 * Notes are plain files a human can open, grep and hand-edit, so the parser is
 * deliberately tolerant of formatting people will inevitably introduce.
 */

import { KINDS } from './config.mjs';

export const SCHEMA_VERSION = 1;
export const SCOPES = ['project', 'global'];

/** Absolute ceiling on a stored body, so one runaway note can't bloat the store. */
const BODY_HARD_CHARS = 64_000;

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Short, sortable-ish, collision-resistant id.
 * Time component keeps ids roughly ordered; random suffix avoids collisions
 * when two agents write in the same millisecond.
 */
export function newId() {
  const t = Date.now().toString(36).slice(-4);
  let r = '';
  for (let i = 0; i < 2; i++) r += B36[Math.floor(Math.random() * 36)];
  return t + r;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Turn arbitrary tag input into a clean, deduped, lowercase list. */
export function normalizeTags(tags) {
  const raw = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  const seen = new Set();
  for (const t of raw) {
    const clean = String(t).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._/-]/g, '');
    if (clean) seen.add(clean);
  }
  return [...seen].slice(0, 12);
}

/** Collapse whitespace and clip — used for titles and descriptions. */
export function oneLine(s, max = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

export function wordCount(s) {
  const m = String(s ?? '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Build a complete, valid note from partial input.
 * Throws on genuinely unusable input; coerces everything else.
 */
export function makeNote(input = {}, ctx = {}) {
  const title = oneLine(input.title, 120);
  if (!title) throw new Error('note requires a title');

  const body = String(input.body ?? input.content ?? '').trim();
  if (!body) throw new Error('note requires a body');

  const kind = KINDS.includes(input.kind) ? input.kind : 'reference';
  const scope = SCOPES.includes(input.scope) ? input.scope : 'project';
  const created = input.created || nowIso();

  return {
    v: SCHEMA_VERSION,
    id: input.id || newId(),
    title,
    // Fall back to the body's first sentence so the seed line is never empty.
    desc: oneLine(input.desc || firstSentence(body), 160),
    kind,
    tags: normalizeTags(input.tags),
    scope,
    project: scope === 'global' ? null : input.project ?? ctx.project ?? null,
    // The project a note was *learned in*, kept even after it goes global — so
    // the global tree can group one branch per project. `project` is nulled on a
    // global note (it belongs everywhere now); `origin` remembers where it came
    // from. Disk re-reads carry no `ctx.project`, so an old global with neither
    // stays unattributed (an "everywhere" branch) rather than being mislabelled.
    origin: input.origin ?? input.project ?? ctx.project ?? null,
    agent: input.agent ?? ctx.agent ?? null,
    session: input.session ?? ctx.session ?? null,
    created,
    updated: input.updated || created,
    reads: Number.isFinite(input.reads) ? input.reads : 0,
    pinned: Boolean(input.pinned),
    archived: Boolean(input.archived),
    supersedes: input.supersedes || null,
    links: Array.isArray(input.links) ? input.links.filter(Boolean).slice(0, 20) : [],
    body: body.length > BODY_HARD_CHARS ? body.slice(0, BODY_HARD_CHARS) + '\n\n…[truncated]' : body,
  };
}

function firstSentence(body) {
  const text = body.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim();
  const m = text.match(/^(.{10,200}?[.!?])(\s|$)/);
  return m ? m[1] : text.slice(0, 160);
}

/**
 * Check a body against the configured word budget.
 * Returns a warning rather than truncating — silently discarding what an agent
 * wrote is worse than telling it to be briefer next time.
 */
export function checkBodyBudget(body, maxWords) {
  const words = wordCount(body);
  if (!maxWords || words <= maxWords) return null;
  return `note body is ${words} words; the configured budget is ${maxWords}. Consider tightening it — long notes cost tokens every time they're read.`;
}

/* ------------------------------------------------------------------ *
 * Frontmatter
 * ------------------------------------------------------------------ */

/** Serialise one scalar/array value in the small YAML subset we emit. */
function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(', ')}]`;
  const s = String(v);
  // Quote anything that could be misread as YAML structure or another type.
  if (
    s === '' ||
    /^[\s>|&*!%@`#-]/.test(s) ||
    /[:#]\s/.test(s) ||
    /[:,[\]{}"']/.test(s) ||
    /\s$/.test(s) ||
    /^(true|false|null|~|\d+(\.\d+)?)$/i.test(s)
  ) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

const FRONT_KEYS = [
  'v', 'id', 'title', 'desc', 'kind', 'tags', 'scope', 'project', 'origin', 'agent',
  'session', 'created', 'updated', 'reads', 'pinned', 'archived', 'supersedes', 'links',
];

/** Note -> Markdown file contents. */
export function serializeNote(note) {
  const lines = ['---'];
  for (const k of FRONT_KEYS) lines.push(`${k}: ${yamlValue(note[k])}`);
  lines.push('---', '', note.body.trim(), '');
  return lines.join('\n');
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1)) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => parseScalar(x));
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/**
 * Markdown file contents -> `{ data, body }`.
 * A file with no frontmatter yields empty data and the whole text as body,
 * so a hand-written note still imports cleanly.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return { data: {}, body: src.trim() };

  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) data[key] = parseScalar(line.slice(idx + 1));
  }
  return { data, body: (m[2] || '').trim() };
}

/** Markdown file contents -> a fully-normalised note (or null if unusable). */
export function deserializeNote(text, ctx = {}) {
  const { data, body } = parseFrontmatter(text);
  if (!data.title && !body) return null;
  try {
    return makeNote({ ...data, title: data.title || oneLine(body, 80), body }, ctx);
  } catch {
    return null;
  }
}

/** The subset stored in `index.json` — everything the hot path needs, no bodies. */
export function toIndexEntry(note, file) {
  return {
    id: note.id,
    title: note.title,
    desc: note.desc,
    kind: note.kind,
    tags: note.tags,
    scope: note.scope,
    project: note.project,
    origin: note.origin,
    agent: note.agent,
    session: note.session,
    created: note.created,
    updated: note.updated,
    reads: note.reads,
    pinned: note.pinned,
    archived: note.archived,
    supersedes: note.supersedes,
    links: note.links,
    file,
  };
}
