/**
 * Turning somebody else's record into a note.
 *
 * Every source — claude-mem, a MEMORY.md, a JSON dump — eventually hands us a
 * loose object and asks for a note. There is no schema to rely on, so this is
 * unapologetically heuristic: try the field names tools actually use, in the
 * order they're likely to be right, and skip anything that doesn't look like a
 * memory rather than importing noise.
 *
 * Noise is the specific failure mode worth guarding against. note-tree's whole
 * argument is that a small number of good notes beats a transcript, so an
 * importer that faithfully drags in 4,000 tool-call observations would import
 * the exact problem we exist to solve.
 */

import { KINDS } from '../config.mjs';
import { oneLine } from '../note.mjs';

const TITLE_KEYS = ['title', 'name', 'heading', 'subject', 'topic', 'label'];
const BODY_KEYS = ['body', 'content', 'text', 'memory', 'note', 'observation', 'document', 'summary', 'description', 'value'];
const DESC_KEYS = ['desc', 'description', 'summary', 'excerpt', 'preview'];
const TAG_KEYS = ['tags', 'keywords', 'labels', 'topics'];
const KIND_KEYS = ['kind', 'type', 'category', 'entity_type', 'entityType'];
const TIME_KEYS = ['created', 'created_at', 'createdAt', 'timestamp', 'ts', 'time', 'date', 'started_at', 'startedAt'];
const UPDATED_KEYS = ['updated', 'updated_at', 'updatedAt', 'modified', 'modified_at', 'lastModified'];
const PROJECT_KEYS = ['project', 'project_name', 'projectName', 'repo', 'workspace', 'cwd'];
const SESSION_KEYS = ['session', 'session_id', 'sessionId', 'conversation_id', 'conversationId', 'run_id'];

/** Below this a "memory" is a fragment, not something worth a leaf. */
const MIN_BODY = 24;

/**
 * Word → kind. Ordered: the first match wins, so the more specific cues come
 * first. Matched against the heading, the declared type, and the text itself.
 *
 * Plurals and suffixes are spelled out deliberately. A heading is almost always
 * `## Gotchas`, never `## Gotcha`, and a stem with a trailing `\b` matches
 * neither that nor `Architecture` — which silently files half a MEMORY.md as
 * `reference`.
 */
const KIND_CUES = [
  [/\b(gotchas?|pitfalls?|caveats?|warnings?|footguns?|beware|surprising|breaks?|broke|bugs?)\b/i, 'gotcha'],
  [/\b(decid\w*|decisions?|chose|choice|rationale|why we|instead of|trade-?offs?)\b/i, 'decision'],
  [/\b(conventions?|conventional|standards?|styles?|naming|formats?|formatting|lint\w*|always |never )/i, 'convention'],
  [/\b(architect\w*|structures?|layouts?|modules?|pipelines?|data ?flow|boundar\w+|components?)\b/i, 'architecture'],
  [/\b(prefers?|preference|preferred|likes to|dislikes?|wants?|style of work)\b/i, 'preference'],
  [/\b(todos?|to-?do|next steps?|follow-?ups?|backlog|fixme)\b/i, 'todo'],
];

/** Fields whose presence means we're looking at a transcript, not a memory. */
const TRANSCRIPT_MARKERS = ['role', 'tool_use', 'tool_use_id', 'toolUseId', 'tool_calls', 'messages', 'stop_reason'];

/**
 * @param record   any object from a source
 * @param opts.scope   'project' | 'global'
 * @param opts.maxBody trim bodies past this many chars
 * @returns a note input, or `{ skip: reason }`
 */
export function toNote(record, { scope = 'project', maxBody = 4000, project = null, source = null } = {}) {
  if (!record || typeof record !== 'object') return { skip: 'not an object' };

  const flat = flatten(record);

  if (TRANSCRIPT_MARKERS.some((k) => k in flat) && !pick(flat, TITLE_KEYS)) {
    return { skip: 'looks like a transcript turn, not a memory' };
  }

  let body = str(pick(flat, BODY_KEYS));
  let title = oneLine(str(pick(flat, TITLE_KEYS)), 120);

  // A record with a title and no body still carries something worth keeping;
  // the reverse is the common case and the first sentence makes a fine title.
  if (!body && title) body = title;
  if (!title && body) title = oneLine(firstSentence(body), 120);
  if (!body || body.length < MIN_BODY) return { skip: 'no usable body' };

  if (body.length > maxBody) body = `${body.slice(0, maxBody).trimEnd()}\n\n…[truncated on import]`;

  const declaredKind = String(pick(flat, KIND_KEYS) || '');
  const created = when(pick(flat, TIME_KEYS));
  const updated = when(pick(flat, UPDATED_KEYS)) || created;

  const desc = oneLine(str(pick(flat, DESC_KEYS)), 160);

  return {
    title,
    desc: desc && desc !== title ? desc : '',
    body,
    kind: inferKind(declaredKind, `${title} ${body.slice(0, 400)}`),
    scope,
    tags: tagsFrom(flat, source),
    project: scope === 'global' ? null : project,
    // Attribution is honest about provenance: these notes were not written here.
    agent: source ? `import:${source}` : 'import',
    session: str(pick(flat, SESSION_KEYS)) || null,
    created,
    updated,
  };
}

/** A declared kind wins when it's one of ours; otherwise read the text. */
export function inferKind(declared, text) {
  const d = String(declared || '').toLowerCase().trim();
  if (KINDS.includes(d)) return d;
  for (const [re, kind] of KIND_CUES) if (re.test(d)) return kind;
  for (const [re, kind] of KIND_CUES) if (re.test(text || '')) return kind;
  return 'reference';
}

/**
 * Timestamps arrive as ISO strings, epoch seconds, or epoch milliseconds. The
 * seconds/millis split is decided by magnitude, which is unambiguous for any
 * date this side of 1970 + 33 years.
 */
export function when(value) {
  if (value == null) return undefined;
  if (typeof value === 'number' || /^\d{9,14}$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/* ------------------------------------------------------------- internals -- */

/**
 * One level of nesting, flattened.
 *
 * Tools routinely wrap the interesting fields in `metadata` or `data`, and a
 * mapper that only looks at the top level misses every one of them.
 */
function flatten(record) {
  const out = { ...record };
  for (const key of ['metadata', 'meta', 'data', 'attributes', 'properties', 'fields']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested)) if (!(k in out)) out[k] = v;
    }
  }
  // A JSON string in a text column is common enough to be worth one attempt.
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.length > 2 && v[0] === '{' && v.endsWith('}')) {
      try {
        const parsed = JSON.parse(v);
        for (const [nk, nv] of Object.entries(parsed)) if (!(nk in out)) out[nk] = nv;
      } catch {
        /* it was just a string that looked like JSON */
      }
    }
  }
  return out;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function str(value) {
  if (value == null) return '';
  // A blob holding text is common; a blob holding an embedding is not text at
  // all, so control bytes are stripped rather than smuggled into a note.
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
  if (Array.isArray(value)) return value.map(str).filter(Boolean).join('\n');
  if (typeof value === 'object') return '';
  return String(value).trim();
}

function tagsFrom(flat, source) {
  const tags = [];
  for (const key of TAG_KEYS) {
    const v = flat[key];
    if (Array.isArray(v)) tags.push(...v.map(str));
    else if (typeof v === 'string') tags.push(...v.split(/[,\s]+/));
  }
  const project = str(pick(flat, PROJECT_KEYS));
  // A path is a location, not a topic; its basename usually is a topic.
  if (project && !/[/\\]/.test(project)) tags.push(project);
  if (source) tags.push(source);
  return tags.filter(Boolean).slice(0, 12);
}

function firstSentence(text) {
  const clean = String(text).replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^(.{10,110}?[.!?])(\s|$)/);
  return m ? m[1] : clean.slice(0, 110);
}
