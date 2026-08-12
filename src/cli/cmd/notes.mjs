/**
 * The everyday commands: writing notes, finding them, and curating them.
 *
 * These are what someone runs twenty times a day, so the output is tuned for
 * scanning — id first, kind as one coloured glyph, age right-aligned, title
 * given whatever room is left.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { open, resolveId, forEachId, duration } from './_shared.mjs';
import { many, num, scopeFrom } from '../args.mjs';
import {
  say, ok, warn, info, fail, dim, bold, gray, yellow, cyan, json,
  table, NOTE_COLUMNS, noteRow, wrap, age, ago, kindColor, kindGlyph,
  confirm, readStdin, SYM, termWidth,
} from '../out.mjs';
import { KINDS } from '../../config.mjs';
import { rankNotes, explain } from '../../rank.mjs';
import { renderNote } from '../../seed.mjs';
import { serializeNote, deserializeNote } from '../../note.mjs';

/* --------------------------------------------------------------- add ----- */

export async function add(args) {
  const { flags, positionals } = args;
  const title = positionals.join(' ').trim();
  if (!title) throw new Error('a title is required — `note-tree add "what you learned"`');

  let body = typeof flags.body === 'string' ? flags.body : '';
  if (flags.stdin || (!body && !process.stdin.isTTY)) body = (await readStdin()).trim();
  if (!body) body = title; // a title-only note is still a note

  const ctx = open(args);
  const result = ctx.write(
    {
      title,
      body,
      kind: typeof flags.kind === 'string' ? flags.kind : undefined,
      tags: many(flags.tag),
      scope: flags.global ? 'global' : 'project',
      desc: typeof flags.desc === 'string' ? flags.desc : undefined,
      pinned: Boolean(flags.pin),
    },
    { force: Boolean(flags.force) },
  );

  if (result.status === 'duplicate') {
    const d = result.duplicate;
    say(warn(`This looks like a note you already have (${Math.round(d.score * 100)}% similar):`));
    say(`  ${dim(d.id)} ${kindColor(d.kind, kindGlyph(d.kind))} ${d.title}`);
    say(dim(`  Update it:  note-tree edit ${d.id}`));
    say(dim(`  Or save anyway:  note-tree add … --force`));
    return 1;
  }

  if (args.json) return json(result.note), 0;
  for (const w of result.warnings) say(info(gray(w)));
  say(ok(`${result.status === 'created' ? 'Saved' : 'Updated'} ${bold(result.note.id)} ${dim(`(${result.note.scope})`)}`));
  say(`  ${kindColor(result.note.kind, kindGlyph(result.note.kind))} ${result.note.title}`);
  return 0;
}

/* -------------------------------------------------------------- list ----- */

export async function list(args) {
  const { flags } = args;
  const ctx = open(args);
  const scope = scopeFrom(flags, 'all');
  const includeArchived = Boolean(flags.archived);

  let entries = scope === 'all' ? ctx.allEntries() : ctx.entries(scope);
  if (!includeArchived) entries = entries.filter((n) => !n.archived);
  if (flags.pinned) entries = entries.filter((n) => n.pinned);

  const kinds = many(flags.kind);
  if (kinds.length) entries = entries.filter((n) => kinds.includes(n.kind));
  const tags = many(flags.tag);
  if (tags.length) entries = entries.filter((n) => tags.every((t) => (n.tags || []).includes(t)));

  const ranked = rankNotes(entries, ctx.cfg, { includeArchived });
  const limit = num(flags.limit, 20);
  const shown = limit > 0 ? ranked.slice(0, limit) : ranked;

  if (args.json) return json(shown), 0;

  if (!shown.length) {
    say(gray(entries.length ? 'Nothing matches those filters.' : 'No notes yet.'));
    if (!entries.length) say(dim(`Save the first one:  note-tree add "what you just learned"`));
    return 0;
  }

  const now = Date.now();
  say(table(shown.map((n) => noteRow(n, { showScope: scope === 'all', now })), { columns: NOTE_COLUMNS }));

  if (flags.why) {
    say('');
    say(bold('Why this order'));
    for (const n of shown.slice(0, 10)) {
      const e = explain(n, ctx.cfg, now);
      say(
        `  ${dim(n.id)} ${bold(String(Math.round(e.total)).padStart(5))}  ` +
          dim(`pinned ${e.pinned} + kind ${e.kind} + recency ${e.recency.toFixed(1)} + reads ${e.reads}`),
      );
    }
  }

  if (limit > 0 && ranked.length > shown.length) {
    say(dim(`\n${ranked.length - shown.length} more · --limit 0 to see everything`));
  }
  return 0;
}

/* -------------------------------------------------------------- show ----- */

export async function show(args) {
  const ids = args.positionals;
  if (!ids.length) throw new Error('which note? `note-tree show <id>`');

  const ctx = open(args);
  const found = [];
  let failures = 0;
  for (const raw of ids) {
    try {
      found.push(resolveId(ctx, raw));
    } catch (error) {
      fail(error.message);
      failures++;
    }
  }
  if (!found.length) return 1;

  // Reads feed ranking, so recalling a note makes it surface sooner next time.
  if (args.flags.count !== false) ctx.store.markRead(found.map((n) => n.id));

  if (args.json) return json(found.length === 1 ? found[0] : found), failures ? 1 : 0;

  const width = termWidth();
  found.forEach((n, i) => {
    if (i) say(dim('─'.repeat(width)));
    say('');
    say(`${kindColor(n.kind, kindGlyph(n.kind))} ${bold(n.title)}${n.pinned ? ` ${yellow(SYM.pin)}` : ''}`);
    const meta = [
      dim(n.id),
      kindColor(n.kind, n.kind),
      dim(n.scope),
      dim(ago(n.updated || n.created)),
      n.reads ? dim(`${n.reads} recall${n.reads === 1 ? '' : 's'}`) : '',
      n.agent ? dim(`via ${n.agent}`) : '',
      n.archived ? yellow('archived') : '',
    ].filter(Boolean);
    say(`  ${meta.join(dim(` ${SYM.dot} `))}`);
    // The description is what the seed actually spends tokens on, so it's worth
    // seeing — unless it just repeats the title, in which case it isn't.
    if (n.desc && n.desc.trim().toLowerCase() !== n.title.trim().toLowerCase()) {
      say(dim(wrap(n.desc, width - 4, '  ')));
    }
    if (n.tags?.length) say(`  ${n.tags.map((t) => cyan(`#${t}`)).join(' ')}`);
    say('');
    say(wrap(n.body, width - 4, '  '));
    say('');
  });
  return failures ? 1 : 0;
}

/* ------------------------------------------------------------ search ----- */

export async function search(args) {
  const query = args.positionals.join(' ').trim();
  if (!query) throw new Error('search for what? `note-tree search <query>`');

  const ctx = open(args);
  const limit = num(args.flags.limit, 10);
  const hits = ctx.search(query, { limit, deep: Boolean(args.flags.deep) });

  if (args.json) return json(hits), 0;
  if (!hits.length) {
    say(gray(`Nothing matches ${bold(query)}.`));
    if (!args.flags.deep) say(dim('Try --deep to search note bodies too.'));
    return 0;
  }

  const now = Date.now();
  say(table(hits.map((n) => noteRow(n, { now })), { columns: NOTE_COLUMNS }));
  say(dim(`\n${hits.length} result${hits.length === 1 ? '' : 's'} · note-tree show <id>`));
  return 0;
}

/* -------------------------------------------------------------- edit ----- */

export async function edit(args) {
  const ctx = open(args);
  const note = resolveId(ctx, args.positionals[0]);
  const { flags } = args;

  const patch = {};
  if (typeof flags.title === 'string') patch.title = flags.title;
  if (typeof flags.body === 'string') patch.body = flags.body;
  if (typeof flags.kind === 'string') patch.kind = flags.kind;
  if (typeof flags.desc === 'string') patch.desc = flags.desc;
  if (flags.tag !== undefined) patch.tags = many(flags.tag);

  // No flags means the note itself is the interface: open it in $EDITOR as the
  // same Markdown file that lives on disk.
  if (!Object.keys(patch).length) {
    const edited = editInEditor(note);
    if (edited === null) {
      say(gray('No changes.'));
      return 0;
    }
    Object.assign(patch, edited);
  }

  const result = ctx.write({ ...patch, id: note.id, scope: patch.scope || note.scope });
  for (const w of result.warnings) say(info(gray(w)));
  say(ok(`Updated ${bold(result.note.id)}`));
  say(`  ${kindColor(result.note.kind, kindGlyph(result.note.kind))} ${result.note.title}`);
  return 0;
}

function editInEditor(note) {
  const editor = process.env.NOTE_TREE_EDITOR || process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    throw new Error('set $EDITOR, or pass --title/--body/--kind/--tag directly');
  }
  const file = path.join(os.tmpdir(), `note-tree-${note.id}.md`);
  const before = serializeNote(note);
  fs.writeFileSync(file, before);
  try {
    const [bin, ...rest] = editor.split(/\s+/);
    const r = spawnSync(bin, [...rest, file], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.error) throw r.error;
    const after = fs.readFileSync(file, 'utf8');
    if (after === before) return null;
    const parsed = deserializeNote(after);
    return { title: parsed.title, body: parsed.body, kind: parsed.kind, tags: parsed.tags, desc: parsed.desc };
  } finally {
    try { fs.unlinkSync(file); } catch { /* the editor may have moved it */ }
  }
}

/* ---------------------------------------------------------- flag verbs ---- */

const verb = (fn, past) => async (args) => {
  const ids = args.positionals;
  if (!ids.length) throw new Error(`which note? \`note-tree ${past.cmd} <id>\``);
  const ctx = open(args);
  return forEachId(ctx, ids, (note) => {
    const updated = fn(ctx, note);
    if (!updated) throw new Error(`could not ${past.cmd} ${note.id}`);
    say(ok(`${past.label} ${bold(updated.id)} ${dim(updated.title)}`));
  });
};

export const pin = verb((ctx, n) => ctx.store.pin(n.id), { cmd: 'pin', label: 'Pinned' });
export const unpin = verb((ctx, n) => ctx.store.unpin(n.id), { cmd: 'unpin', label: 'Unpinned' });
export const archive = verb((ctx, n) => ctx.store.archive(n.id), { cmd: 'archive', label: 'Archived' });
export const restore = verb((ctx, n) => ctx.store.restore(n.id), { cmd: 'restore', label: 'Restored' });
export const promote = verb((ctx, n) => ctx.store.promote(n.id), { cmd: 'promote', label: 'Promoted to global:' });
export const demote = verb((ctx, n) => ctx.store.demote(n.id), { cmd: 'demote', label: 'Moved into this project:' });

/* ------------------------------------------------------------ remove ----- */

export async function remove(args) {
  const ids = args.positionals;
  if (!ids.length) throw new Error('which note? `note-tree rm <id>`');

  const ctx = open(args);
  const targets = [];
  for (const raw of ids) {
    try {
      targets.push(resolveId(ctx, raw));
    } catch (error) {
      fail(error.message);
    }
  }
  if (!targets.length) return 1;

  for (const n of targets) say(`  ${dim(n.id)} ${kindColor(n.kind, kindGlyph(n.kind))} ${n.title}`);
  const yes = await confirm(
    `Delete ${targets.length} note${targets.length === 1 ? '' : 's'} permanently?`,
    { yes: Boolean(args.flags.yes) },
  );
  if (!yes) {
    say(gray('Left alone. `note-tree archive` retires a note without losing it.'));
    return 0;
  }
  for (const n of targets) ctx.store.remove(n.id);
  say(ok(`Deleted ${targets.length} note${targets.length === 1 ? '' : 's'}.`));
  return 0;
}

/* ------------------------------------------------------------- prune ----- */

export async function prune(args) {
  const { flags } = args;
  const ctx = open(args);
  const cutoff = Date.now() - (duration(flags['older-than'], null) ?? 180 * 86_400_000);

  const kinds = many(flags.kind);
  const candidates = ctx
    .allEntries()
    .filter((n) => !n.archived && !n.pinned)
    .filter((n) => Date.parse(n.updated || n.created || '') < cutoff)
    .filter((n) => (flags.unread ? !n.reads : true))
    .filter((n) => (kinds.length ? kinds.includes(n.kind) : true))
    .sort((a, b) => Date.parse(a.updated || a.created) - Date.parse(b.updated || b.created));

  if (args.json) return json(candidates), 0;
  if (!candidates.length) {
    say(ok('Nothing to prune — the tree is healthy.'));
    return 0;
  }

  const now = Date.now();
  say(bold(`${candidates.length} note${candidates.length === 1 ? '' : 's'} look ready to retire`));
  say(dim(`untouched for over ${flags['older-than'] || '180d'}${flags.unread ? ', never recalled' : ''}, not pinned`));
  say('');
  say(table(candidates.map((n) => noteRow(n, { now })), { columns: NOTE_COLUMNS }));

  const destructive = Boolean(flags.delete);
  if (!flags.apply && !destructive) {
    say(dim(`\nThis was a dry run. Add ${bold('--apply')} to archive them, or ${bold('--delete')} to remove them.`));
    return 0;
  }

  const yes = await confirm(
    destructive ? `Delete these ${candidates.length} notes permanently?` : `Archive these ${candidates.length} notes?`,
    { yes: Boolean(flags.yes) },
  );
  if (!yes) return say(gray('Left alone.')), 0;

  for (const n of candidates) destructive ? ctx.store.remove(n.id) : ctx.store.archive(n.id);
  say(ok(`${destructive ? 'Deleted' : 'Archived'} ${candidates.length} notes.`));
  return 0;
}
