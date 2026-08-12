/**
 * The import registry — one entry per thing you might be migrating from.
 *
 * Switching memory tools should cost one command, not an afternoon of copying
 * bullets by hand. That makes this the highest-leverage file in the project for
 * adoption, and the one with the least control over its inputs: every source
 * here belongs to somebody else and can change shape without telling us.
 *
 * So the contract is narrow and honest. A source knows where to look and which
 * reader to use; the readers below it are heuristic and say what they skipped;
 * nothing writes anything. The command decides what to keep, and `--dry-run`
 * shows you the whole decision before a single note lands.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStore, readFile as readDataFile, findClaudeMemHome } from './claude-mem.mjs';
import { importMarkdownFile } from './markdown.mjs';
import { toNote } from './map.mjs';

const HOME = os.homedir();

/**
 * Markdown memory lives in a handful of well-known places, and which one is
 * present tells us something: a file inside the project is project memory, a
 * file under `~/.claude` follows you everywhere and is global.
 */
const MARKDOWN_SOURCES = [
  {
    id: 'memory-md',
    label: 'MEMORY.md',
    blurb: "Claude Code's native Auto Memory file",
    candidates: (cwd) => [
      path.join(cwd, 'MEMORY.md'),
      path.join(cwd, '.claude', 'MEMORY.md'),
      path.join(HOME, '.claude', 'MEMORY.md'),
      path.join(HOME, '.claude', 'memory', 'MEMORY.md'),
    ],
  },
  {
    id: 'claude-md',
    label: 'CLAUDE.md',
    blurb: 'project or user instructions Claude already loads',
    candidates: (cwd) => [
      path.join(cwd, 'CLAUDE.md'),
      path.join(cwd, '.claude', 'CLAUDE.md'),
      path.join(HOME, '.claude', 'CLAUDE.md'),
    ],
  },
  {
    id: 'agents-md',
    label: 'AGENTS.md',
    blurb: 'the cross-tool instructions file',
    candidates: (cwd) => [path.join(cwd, 'AGENTS.md')],
  },
];

export const SOURCES = [
  {
    id: 'claude-mem',
    label: 'claude-mem',
    blurb: 'the claude-mem plugin store (SQLite, JSON or JSONL)',
    reader: 'records',
    locate: () => findClaudeMemHome(),
  },
  ...MARKDOWN_SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    blurb: s.blurb,
    reader: 'markdown',
    locate: (cwd) => s.candidates(cwd).find(exists) || null,
    candidates: s.candidates,
  })),
  {
    id: 'json',
    label: 'JSON / JSONL',
    blurb: 'any export — needs --file',
    reader: 'records',
    needsFile: true,
    locate: () => null,
  },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);

export function sourceById(id) {
  return SOURCES.find((s) => s.id === String(id || '').toLowerCase()) || null;
}

/** Every source with something to read, so the CLI can offer real choices. */
export function detectSources(cwd = process.cwd()) {
  const found = [];
  for (const source of SOURCES) {
    if (source.needsFile) continue;
    let at = null;
    try {
      at = source.locate(cwd);
    } catch {
      /* a source that can't even look is simply not available */
    }
    if (at) found.push({ id: source.id, label: source.label, at, scope: defaultScope(at, cwd) });
  }
  return found;
}

/**
 * Which tree a file's contents belong in.
 *
 * Memory found inside the project is about the project; memory found in your
 * home config followed you there and will follow you on. Getting this right by
 * default matters — the alternative is a global tree full of one repo's notes.
 */
export function defaultScope(file, cwd = process.cwd()) {
  const rel = path.relative(path.resolve(cwd), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? 'project' : 'global';
}

/** Work out what a `--file` is when `--from` wasn't given. */
export function sniff(file) {
  const base = path.basename(file).toLowerCase();
  if (/\.(md|markdown|mdc|txt)$/.test(base)) {
    if (base.startsWith('claude')) return 'claude-md';
    if (base.startsWith('agents')) return 'agents-md';
    return 'memory-md';
  }
  if (/claude-?mem/.test(path.resolve(file).toLowerCase())) return 'claude-mem';
  return 'json';
}

/**
 * Read a source and turn it into note inputs. Reads only — nothing here touches
 * the store, so `--dry-run` and a real import run exactly the same code.
 *
 * @returns `{ id, label, at, scope, notes, skipped, reasons, warnings, files }`
 */
export function collect({
  source,
  file = null,
  cwd = process.cwd(),
  scope = null,
  project = null,
  limit = 20_000,
  table = null,
  bySection = false,
  maxBody = 4000,
} = {}) {
  const src = sourceById(source);
  if (!src) throw new Error(`unknown source "${source}" — expected ${SOURCE_IDS.join(' | ')}`);

  const at = file ? path.resolve(file) : src.locate(cwd);
  if (!at) {
    const looked = src.candidates ? `\n  looked in:\n    ${src.candidates(cwd).join('\n    ')}` : '';
    throw new Error(`nothing to import from ${src.label}${src.needsFile ? ' — pass --file <path>' : ''}${looked}`);
  }
  if (!exists(at)) throw new Error(`${at} does not exist`);

  const useScope = scope || defaultScope(at, cwd);
  const common = { scope: useScope, project: useScope === 'global' ? null : project, maxBody };

  if (src.reader === 'markdown') {
    const got = importMarkdownFile(at, { ...common, bySection, source: src.id });
    return {
      id: src.id,
      label: src.label,
      at,
      scope: useScope,
      notes: got.notes.slice(0, limit),
      skipped: got.skipped,
      reasons: got.skipped ? [['too short or not a memory', got.skipped]] : [],
      warnings: [],
      files: [{ file: at, kind: 'markdown', count: got.notes.length }],
    };
  }

  const raw = src.id === 'claude-mem' || fs.statSync(at).isDirectory()
    ? readStore({ from: at, table, limit })
    : { ...readDataFile(at, { table, limit }), files: [{ file: at }], home: path.dirname(at) };

  const records = raw.records || [];
  const notes = [];
  const reasons = new Map();
  for (const record of records) {
    if (notes.length >= limit) break;
    const mapped = toNote(record, { ...common, source: src.id });
    if (mapped.skip) {
      reasons.set(mapped.skip, (reasons.get(mapped.skip) || 0) + 1);
      continue;
    }
    notes.push(mapped);
  }

  return {
    id: src.id,
    label: src.label,
    at,
    scope: useScope,
    notes,
    skipped: records.length - notes.length,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    warnings: raw.warnings || [],
    files: raw.files || [],
  };
}

function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}
