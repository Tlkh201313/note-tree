/**
 * Importing a Markdown memory file — `MEMORY.md`, `CLAUDE.md`, `AGENTS.md`.
 *
 * These files are the incumbent format: Claude Code's native Auto Memory keeps
 * one, and most instruction files are the same shape. They are also the reason
 * note-tree exists — the whole file loads every session whether or not any of it
 * is relevant — so importing one well matters more than importing it cleverly.
 *
 * The granularity decision is the whole design here. A `MEMORY.md` is a handful
 * of headings over a few dozen bullets, and *the bullet is the memory*: it's
 * what someone wrote as one fact, and it's the unit note-tree ranks, trims and
 * shows as a leaf. Importing one note per heading would produce eight enormous
 * notes that can never be trimmed usefully — the same all-or-nothing cost we're
 * replacing. So bullets become notes by default, and `--by-section` is there for
 * files that are genuinely prose.
 */

import fs from 'node:fs';
import path from 'node:path';
import { inferKind } from './map.mjs';
import { oneLine } from '../note.mjs';

/** Our own generated block. Importing it would re-import our own output. */
const GENERATED = /<!--\s*note-tree:start\s*-->[\s\S]*?<!--\s*note-tree:end\s*-->/gi;

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE = /^\s*(```|~~~)/;

/** Headings that describe the document rather than remember anything. */
const BOILERPLATE = /^(table of contents|contents|toc|index|overview|about|readme|introduction)$/i;

/**
 * @param text        file contents
 * @param opts.bySection  one note per heading instead of one per bullet
 * @returns `{ notes, skipped, sections }`
 */
export function parseMarkdownMemory(text, {
  bySection = false,
  scope = 'project',
  project = null,
  source = 'memory-md',
  created = undefined,
  minChars = 12,
  maxBody = 4000,
} = {}) {
  const clean = String(text ?? '').replace(GENERATED, '');
  const sections = splitSections(clean);
  const notes = [];
  let skipped = 0;

  for (const section of sections) {
    const heading = section.path[section.path.length - 1] || '';
    if (BOILERPLATE.test(heading)) {
      skipped += 1;
      continue;
    }

    const items = bySection ? [] : bullets(section.lines);
    const prose = section.lines.filter((l) => !BULLET.test(l)).join('\n').trim();

    // A section that is mostly prose keeps its prose, whether or not it also
    // has a stray bullet — throwing away the paragraphs would lose the point.
    if (!items.length || prose.length > 400) {
      const body = section.lines.join('\n').trim();
      if (body.length < minChars || !heading) {
        skipped += 1;
        continue;
      }
      notes.push(note({ title: heading, body, section, scope, project, source, created, maxBody }));
      continue;
    }

    for (const item of items) {
      if (item.trim().length < minChars) {
        skipped += 1;
        continue;
      }
      notes.push(note({ title: firstLine(item), body: item, section, scope, project, source, created, maxBody }));
    }
  }

  return { notes, skipped, sections: sections.length };
}

/** Read a file from disk, using its mtime as the note date. */
export function importMarkdownFile(file, opts = {}) {
  const text = fs.readFileSync(file, 'utf8');
  let created;
  try {
    created = fs.statSync(file).mtime.toISOString();
  } catch {
    /* an unreadable mtime just means the note is dated now */
  }
  return {
    ...parseMarkdownMemory(text, { created, ...opts }),
    file,
    label: path.basename(file),
  };
}

/* ------------------------------------------------------------- internals -- */

function note({ title, body, section, scope, project, source, created, maxBody }) {
  const clipped = body.length > maxBody ? `${body.slice(0, maxBody).trimEnd()}\n\n…[truncated on import]` : body;
  return {
    title: oneLine(plain(title), 120),
    body: clipped,
    kind: inferKind(section.path.join(' '), `${title} ${body}`),
    scope,
    project: scope === 'global' ? null : project,
    // The heading path is the only context a bullet loses when it leaves the
    // file, and as tags it costs nothing in the seed while staying searchable.
    tags: section.path.flatMap(slugTags).slice(0, 8),
    agent: `import:${source}`,
    created,
    updated: created,
  };
}

/**
 * Split into `{ path, lines }`, where `path` is the heading trail.
 *
 * Fenced code is passed through untouched — a `# comment` inside a shell block
 * is not a heading, and treating it as one splits a note in half.
 */
function splitSections(text) {
  const out = [];
  const stack = [];
  let current = { path: [], lines: [] };
  let fence = null;

  for (const raw of String(text).split(/\r?\n/)) {
    const fenceMatch = raw.match(FENCE);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (raw.trim().startsWith(fence)) fence = null;
      current.lines.push(raw);
      continue;
    }
    if (fence) {
      current.lines.push(raw);
      continue;
    }

    const h = raw.match(HEADING);
    if (!h) {
      current.lines.push(raw);
      continue;
    }

    if (current.lines.join('').trim() || current.path.length) out.push(current);
    const depth = h[1].length;
    stack.length = Math.min(stack.length, depth - 1);
    stack[depth - 1] = plain(h[2]);
    current = { path: stack.filter(Boolean).slice(), lines: [] };
  }
  if (current.lines.join('').trim() || current.path.length) out.push(current);

  return out.filter((s) => s.path.length || s.lines.join('').trim());
}

/**
 * Top-level bullets, each with its nested children folded in.
 *
 * "Top level" is relative to the shallowest bullet in the section, because
 * plenty of real files indent their whole list by two spaces.
 */
function bullets(lines) {
  const indents = lines.map((l) => l.match(BULLET)).filter(Boolean).map((m) => m[1].length);
  if (!indents.length) return [];
  const base = Math.min(...indents);

  const items = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(BULLET);
    if (m && m[1].length <= base) {
      if (current) items.push(current.join('\n').trim());
      current = [m[2]];
      continue;
    }
    if (!current) continue; // preamble before the first bullet stays in the prose path
    if (m || line.trim()) current.push(line.trim() ? `  ${line.trim()}` : '');
  }
  if (current) items.push(current.join('\n').trim());
  return items.filter(Boolean);
}

function firstLine(text) {
  const line = String(text).split('\n')[0].trim();
  // A long first line is usually a sentence with the point at the front, and a
  // semicolon splits a bullet the same way a full stop does: "run the tests
  // first; the hook is advisory" is one title and one elaboration.
  const m = line.match(/^(.{16,110}?[.!?:;])(\s|$)/);
  return m ? m[1].replace(/[:.;]$/, '') : line;
}

/** Strip inline Markdown so a title reads as a title. */
function plain(text) {
  return String(text ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/, '')
    .trim();
}

/** A heading becomes at most two tags: "Build & Test" → ['build', 'test']. */
function slugTags(heading) {
  return String(heading)
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/)
    .filter((w) => w.length > 2 && !/^(the|and|for|with|from|our|its|are|how|why|use|using)$/.test(w))
    .slice(0, 2);
}
