/**
 * `note-tree import` — the one command that decides whether someone switches.
 *
 * Nobody abandons a memory tool that already knows things about their project,
 * so the honest version of "try note-tree" is "bring what you have with you".
 * The bar this sets for itself: show the entire decision before it writes, keep
 * provenance on every note, and never turn a transcript into 4,000 leaves.
 */

import { open } from './_shared.mjs';
import { collect, detectSources, sniff, sourceById, SOURCE_IDS } from '../../import/index.mjs';
import { num } from '../args.mjs';
import {
  say, ok, info, warn, dim, bold, cyan, json, table,
  kindColor, kindGlyph, truncate, SYM,
} from '../out.mjs';

export async function importCmd(args) {
  const ctx = open(args);
  const file = typeof args.flags.file === 'string' ? args.flags.file : null;
  const dryRun = Boolean(args.flags['dry-run']);
  const asJson = Boolean(args.flags.json);

  const from = resolveSource(args, ctx, file, asJson);
  if (!from) return 1;

  const scope = args.flags.global ? 'global' : args.flags.project ? 'project' : null;
  const found = collect({
    source: from,
    file,
    cwd: ctx.cwd,
    scope,
    project: ctx.slug,
    limit: num(args.flags.limit, 20_000),
    table: typeof args.flags.table === 'string' ? args.flags.table : null,
    bySection: Boolean(args.flags['by-section']),
    maxBody: (ctx.cfg.budget?.noteBodyWords || 150) * 12,
  });

  if (!found.notes.length) {
    if (asJson) {
      json({ source: found.id, at: found.at, imported: 0, skipped: found.skipped, reasons: found.reasons, warnings: found.warnings });
      return 1;
    }
    say('');
    say(warn(`${found.label} had nothing importable at ${dim(found.at)}`));
    reportSkips(found);
    return 1;
  }

  if (dryRun) {
    if (asJson) {
      json({
        source: found.id, at: found.at, scope: found.scope, dryRun: true,
        wouldImport: found.notes.length, skipped: found.skipped,
        reasons: found.reasons, warnings: found.warnings,
        notes: found.notes.map((n) => ({ title: n.title, kind: n.kind, tags: n.tags, created: n.created, chars: n.body.length })),
      });
      return 0;
    }
    header(found);
    say(kindTable(found.notes));
    say(sample(found.notes));
    reportSkips(found);
    say('');
    say(dim(`  Nothing was written. Re-run without ${bold('--dry-run')} to import.`));
    return 0;
  }

  /* --------------------------------------------------------------- write -- */

  ctx.store.ensure();
  const force = Boolean(args.flags.force);
  const result = { created: 0, duplicate: 0, failed: 0, redacted: 0 };
  const failures = [];

  for (const note of found.notes) {
    try {
      const res = ctx.store.write(
        {
          ...note,
          // One branch per day of imported history, so a year of memory doesn't
          // arrive as a single overloaded branch — the tree keeps meaning what
          // it means: height is time, a branch is one sitting.
          session: note.session || `import-${String(note.created || '').slice(0, 10) || 'legacy'}`,
        },
        { project: ctx.slug, agent: note.agent, session: null },
        { force },
      );
      if (res.status === 'duplicate') result.duplicate++;
      else result.created++;
      if (res.redacted?.length) result.redacted++;
    } catch (error) {
      result.failed++;
      // A single malformed record must not cost you the other 200.
      if (failures.length < 5) failures.push(`${truncate(note.title || '(untitled)', 48)}: ${error.message}`);
    }
  }

  ctx.reindex();

  if (asJson) {
    json({ source: found.id, at: found.at, scope: found.scope, ...result, warnings: found.warnings });
    return result.created ? 0 : 1;
  }

  header(found);
  say('');
  say(`  ${ok(`imported ${bold(String(result.created))} note${result.created === 1 ? '' : 's'} into the ${cyan(found.scope)} tree`)}`);
  if (result.duplicate) {
    say(`  ${info(`${result.duplicate} already looked like notes you have ${dim('(--force imports them anyway)')}`)}`);
  }
  if (result.redacted) say(`  ${info(`${result.redacted} had possible secrets redacted`)}`);
  if (result.failed) {
    say(`  ${warn(`${result.failed} could not be written`)}`);
    for (const f of failures) say(dim(`      ${f}`));
  }
  for (const w of found.warnings.slice(0, 4)) say(`  ${warn(dim(w))}`);
  say('');
  say(dim(`  ${SYM.leaf} see them: ${bold('note-tree tree')}${found.scope === 'global' ? ' --global' : ''}`));
  say('');
  return result.created ? 0 : 1;
}

/* --------------------------------------------------------------- picking -- */

/**
 * Which source to read.
 *
 * Explicit wins, a `--file` is sniffed, and otherwise we look around. Finding
 * exactly one source is the common case and proceeds silently; finding several
 * stops and asks, because importing the wrong tool's history is tedious to undo.
 */
function resolveSource(args, ctx, file, asJson) {
  const asked = typeof args.flags.from === 'string' ? args.flags.from : null;
  if (asked) {
    if (!sourceById(asked)) {
      say(warn(`unknown source "${asked}" — expected ${SOURCE_IDS.join(' | ')}`));
      return null;
    }
    return asked;
  }
  if (file) return sniff(file);

  const detected = detectSources(ctx.cwd);
  if (detected.length === 1) {
    if (!asJson) say(dim(`\n  found ${bold(detected[0].label)} at ${detected[0].at}`));
    return detected[0].id;
  }
  if (!detected.length) {
    say('');
    say(warn('nothing to import from — no claude-mem store, MEMORY.md, CLAUDE.md or AGENTS.md found'));
    say(dim(`  point at a file directly: ${bold('note-tree import --file <path>')}`));
    say('');
    return null;
  }

  say('');
  say(bold('  More than one source is available:'));
  for (const d of detected) {
    say(`    ${cyan(d.id.padEnd(11))} ${dim(d.at)}`);
  }
  say('');
  say(dim(`  Pick one: ${bold(`note-tree import --from ${detected[0].id}`)}`));
  say('');
  return null;
}

/* -------------------------------------------------------------- printing -- */

function header(found) {
  say('');
  say(`  ${bold(found.label)} ${dim(SYM.arrow)} ${dim(found.at)}`);
  const bits = [
    `${found.notes.length} note${found.notes.length === 1 ? '' : 's'}`,
    found.skipped ? `${found.skipped} skipped` : null,
    `${found.scope} tree`,
  ].filter(Boolean);
  say(dim(`  ${bits.join(`  ${SYM.dot}  `)}`));
}

function kindTable(notes) {
  const counts = new Map();
  for (const n of notes) counts.set(n.kind, (counts.get(n.kind) || 0) + 1);
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => [`  ${kindColor(kind, kindGlyph(kind))}`, kindColor(kind, kind), String(count)]);
  return `\n${table(rows, { columns: [{ max: 3 }, { header: '', max: 14 }, { header: '', align: 'right', max: 6 }] })}`;
}

/** A few real titles, because counts don't tell you whether the mapping worked. */
function sample(notes) {
  const shown = notes.slice(0, 6);
  const lines = shown.map((n) => `    ${dim(n.created ? n.created.slice(0, 10) : '')} ${truncate(n.title, 62)}`);
  if (notes.length > shown.length) lines.push(dim(`    … and ${notes.length - shown.length} more`));
  return `\n${dim('  first few')}\n${lines.join('\n')}`;
}

function reportSkips(found) {
  if (found.reasons?.length) {
    say('');
    say(dim('  skipped'));
    for (const [reason, count] of found.reasons.slice(0, 5)) {
      say(dim(`    ${String(count).padStart(5)}  ${reason}`));
    }
  }
  for (const w of (found.warnings || []).slice(0, 4)) say(`  ${warn(dim(w))}`);
}
