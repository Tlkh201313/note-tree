/**
 * Terminal output: colour, glyphs, tables, and the small formatting decisions
 * that make a CLI feel considered rather than assembled.
 *
 * Everything degrades: no colour when piped or when `NO_COLOR` is set, ASCII
 * when the terminal can't be trusted with box glyphs, plain text when `--json`
 * isn't asked for and JSON when it is.
 */

import { kindStyle } from '../theme.mjs';

const env = process.env;

export const COLOR =
  !env.NO_COLOR &&
  env.TERM !== 'dumb' &&
  (env.FORCE_COLOR ? env.FORCE_COLOR !== '0' : Boolean(process.stdout.isTTY));

/**
 * Windows consoles other than Windows Terminal / VS Code still render many
 * glyphs as boxes, so we ask before we draw.
 */
export const UNICODE =
  process.platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI);

const code = (n, s) => (COLOR ? `\u001b[${n}m${s}\u001b[0m` : String(s));

export const bold = (s) => code(1, s);
export const dim = (s) => code(2, s);
export const italic = (s) => code(3, s);
export const red = (s) => code(31, s);
export const green = (s) => code(32, s);
export const yellow = (s) => code(33, s);
export const blue = (s) => code(34, s);
export const magenta = (s) => code(35, s);
export const cyan = (s) => code(36, s);
export const gray = (s) => code(90, s);

/** Colour a string with a kind's palette entry. */
export const kindColor = (kind, s) => code(kindStyle(kind).ansi, s);
export const kindGlyph = (kind) => {
  const st = kindStyle(kind);
  return UNICODE ? st.glyph : st.ascii;
};

export const SYM = UNICODE
  ? { ok: '✔', warn: '!', err: '✖', dot: '·', arrow: '→', pin: '★', leaf: '❦', bullet: '•' }
  : { ok: 'v', warn: '!', err: 'x', dot: '-', arrow: '->', pin: '*', leaf: '~', bullet: '*' };

export const ok = (s) => `${green(SYM.ok)} ${s}`;
export const warn = (s) => `${yellow(SYM.warn)} ${s}`;
export const err = (s) => `${red(SYM.err)} ${s}`;
export const info = (s) => `${gray(SYM.dot)} ${s}`;

export function say(...lines) {
  console.log(lines.join('\n'));
}

/** Errors belong on stderr so `note-tree list --json | jq` stays clean. */
export function fail(message, { code: exitCode = 1 } = {}) {
  console.error(err(message));
  process.exitCode = exitCode;
}

export function json(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function heading(title) {
  return `\n${bold(title)}`;
}

/** Visible width, ignoring the ANSI escapes we may have added. */
export function width(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '').length;
}

export function pad(s, n, align = 'left') {
  const gap = Math.max(0, n - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

export function truncate(s, max) {
  const str = String(s ?? '');
  if (max <= 1 || width(str) <= max) return str;
  return str.slice(0, max - 1) + (UNICODE ? '…' : '.');
}

/**
 * Columns sized to content, capped to the terminal so a long title wraps the
 * layout instead of the layout wrapping the terminal.
 */
export function table(rows, { columns, gap = 2, max = termWidth() } = {}) {
  if (!rows.length) return '';
  const widths = columns.map((c, i) =>
    Math.min(
      c.max ?? Infinity,
      Math.max(width(c.header || ''), ...rows.map((r) => width(r[i] ?? ''))),
    ),
  );

  // Give whatever room is left to the first flexible column.
  const fixed = widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1);
  const flexIdx = columns.findIndex((c) => c.flex);
  if (flexIdx !== -1 && fixed > max) widths[flexIdx] = Math.max(12, widths[flexIdx] - (fixed - max));

  const line = (cells, styleRow = (s) => s) =>
    styleRow(cells.map((c, i) => pad(truncate(c ?? '', widths[i]), widths[i], columns[i].align)).join(' '.repeat(gap)).trimEnd());

  const out = [];
  if (columns.some((c) => c.header)) out.push(line(columns.map((c) => c.header || ''), (s) => dim(s)));
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

export function termWidth() {
  return Math.max(40, Math.min(process.stdout.columns || 100, 120));
}

/** Wrap prose to the terminal, preserving deliberate blank lines. */
export function wrap(text, max = termWidth() - 2, indent = '') {
  const out = [];
  for (const para of String(text ?? '').split(/\n/)) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = indent;
    for (const word of para.split(/\s+/)) {
      if (width(line) + word.length + 1 > max && line.trim()) {
        out.push(line.trimEnd());
        line = indent;
      }
      line += (line === indent ? '' : ' ') + word;
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out.join('\n');
}

/** "3d", "2mo" — the same compact ages the seed uses, so nothing contradicts. */
export function age(when, now = Date.now()) {
  const t = typeof when === 'number' ? when : Date.parse(when || '');
  if (!Number.isFinite(t)) return '?';
  const mins = Math.max(0, (now - t) / 60_000);
  // A note saved moments ago should not read as an hour old — the first minutes
  // are exactly when you're looking to confirm it landed.
  if (mins < 1) return 'now';
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = mins / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d`;
  if (d < 30) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(d < 730 ? 1 : 0)}y`;
}

/** "just now", "3d ago" — for prose, where a bare "now ago" would read wrong. */
export function ago(when, now = Date.now()) {
  const a = age(when, now);
  return a === 'now' ? 'just now' : a === '?' ? 'unknown' : `${a} ago`;
}

/** One note as a list row: `a3f2 ▲ 3d  Title  #tag` */
export function noteRow(n, { showScope = true, now = Date.now() } = {}) {
  return [
    dim(n.id),
    kindColor(n.kind, kindGlyph(n.kind)),
    // One column, two states worth flagging: pinned rises, archived has fallen.
    n.pinned ? yellow(SYM.pin) : n.archived ? dim(SYM.dot) : ' ',
    dim(age(n.updated || n.created, now)),
    showScope ? dim(n.scope === 'global' ? 'glob' : 'proj') : '',
    n.archived ? dim(n.title) : n.title,
  ];
}

export const NOTE_COLUMNS = [
  { header: 'id', max: 8 },
  { header: '', max: 1 },
  { header: '', max: 1 },
  { header: 'age', max: 5, align: 'right' },
  { header: 'scope', max: 5 },
  { header: 'title', flex: true },
];

/** A yes/no prompt that answers itself when there's no human attached. */
export async function confirm(question, { yes = false, fallback = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) return fallback;
  process.stdout.write(`${question} ${dim('[y/N]')} `);
  return new Promise((resolve) => {
    const onData = (chunk) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(/^y(es)?$/i.test(String(chunk).trim()));
    };
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/** Read piped stdin, so `git log | note-tree add --stdin` works. */
export async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
