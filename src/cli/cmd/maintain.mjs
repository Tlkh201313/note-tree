/**
 * `status`, `sync`, `migrate` — keeping the store honest.
 *
 * Notes are plain files on purpose, which means people will hand-edit them,
 * `git pull` them, and move them around. `sync` is the command that makes that
 * safe: rebuild the index from what's actually on disk, then regenerate
 * everything derived from it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { open } from './_shared.mjs';
import { loadConfig, saveGlobalConfig, readJsonSafe } from '../../config.mjs';
import { projectSlug } from '../../paths.mjs';
import { loadRegistry } from '../../index-cache.mjs';
import { size as journalSize } from '../../journal.mjs';
import { rankNotes } from '../../rank.mjs';
import { stageFor } from '../../theme.mjs';
import { SCHEMA_VERSION } from '../../note.mjs';
import { FORMATS } from '../../store/index.mjs';
import {
  say, ok, warn, info, dim, bold, gray, green, yellow, cyan, json,
  table, age, kindColor, kindGlyph, confirm, SYM,
} from '../out.mjs';

/* ------------------------------------------------------------ status ----- */

export async function status(args) {
  const ctx = open(args);
  const stats = ctx.store.stats();
  const project = ctx.entries('project');
  const global = ctx.entries('global');
  const seed = ctx.seed();
  const registry = loadRegistry(ctx.paths);

  const payload = {
    project: ctx.slug,
    root: ctx.paths.root,
    format: stats.format,
    counts: { project: project.filter((n) => !n.archived).length, global: global.filter((n) => !n.archived).length, archived: stats.archived, pinned: stats.pinned },
    stage: stageFor(project.filter((n) => !n.archived).length),
    seed: seed ? { chars: seed.chars, tokens: seed.tokens, counts: seed.counts, truncated: seed.truncated } : null,
    verbosity: ctx.cfg.verbosity,
    agents: ctx.cfg.agents?.enabled || [],
    projects: Object.keys(registry.projects || {}).length,
  };
  if (args.json) return json(payload), 0;

  const active = project.filter((n) => !n.archived);
  say('');
  say(`${bold(ctx.slug || 'no project')}  ${dim(stageFor(active.length))}`);
  say(dim(`${ctx.paths.root}  ${SYM.dot}  ${stats.format}  ${SYM.dot}  schema v${SCHEMA_VERSION}`));
  say('');

  const rows = [
    ['project notes', String(active.length)],
    ['global notes', String(global.filter((n) => !n.archived).length)],
    ['pinned', String(stats.pinned)],
    ['archived', String(stats.archived)],
    [
      'session cost',
      seed
        ? `${cyan(`~${seed.tokens} tokens`)} ${dim(`(${seed.chars} chars, ${ctx.cfg.verbosity}${seed.truncated ? `, ${seed.counts.dropped} trimmed` : ''})`)}`
        : dim('nothing to inject yet'),
    ],
    ['wired agents', (ctx.cfg.agents?.enabled || []).join(', ') || dim('none — run `note-tree init`')],
    ['other projects', String(Math.max(0, payload.projects - 1))],
  ];
  say(table(rows.map(([k, v]) => [dim(k), v]), { columns: [{ header: '' }, { header: '', flex: true }] }));

  if (Object.keys(stats.kinds).length) {
    say('');
    const total = Object.values(stats.kinds).reduce((a, b) => a + b, 0);
    const bar = Object.entries(stats.kinds)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => kindColor(kind, kindGlyph(kind).repeat(Math.max(1, Math.round((n / total) * 24)))))
      .join('');
    say(`  ${bar}`);
    say(
      '  ' +
        Object.entries(stats.kinds)
          .sort((a, b) => b[1] - a[1])
          .map(([kind, n]) => `${kindColor(kind, kindGlyph(kind))} ${dim(`${kind} ${n}`)}`)
          .join('   '),
    );
  }

  const top = rankNotes([...project, ...global], ctx.cfg).slice(0, 3);
  if (top.length) {
    say('');
    say(dim('  most likely to be recalled next session'));
    for (const n of top) {
      say(`    ${kindColor(n.kind, kindGlyph(n.kind))} ${n.title} ${dim(`${SYM.dot} ${age(n.updated || n.created)}`)}`);
    }
  }

  const jsize = journalSize(ctx.paths.journal);
  if (jsize) say(dim(`\n  journal ${(jsize / 1024).toFixed(0)} KB`));
  return 0;
}

/* -------------------------------------------------------------- sync ----- */

export async function sync(args) {
  const targets = args.flags.all ? everyProject(args) : [{ slug: projectSlug(args.cwd), cwd: args.cwd }];
  const results = [];

  for (const t of targets) {
    // Pass both: the slug picks the store, the cwd decides where — and whether —
    // a Tier B block gets rewritten.
    const ctx = open(args, { cwd: t.cwd, slug: t.slug, withProject: true });
    results.push({ slug: ctx.slug, cwd: t.cwd, ...ctx.reindex() });
  }

  if (args.json) return json(results), 0;

  for (const r of results) {
    say(
      ok(
        `${bold(r.slug || 'global')}  ${dim(`${r.project ?? 0} project + ${r.global ?? 0} global note${r.global === 1 ? '' : 's'} indexed`)}`,
      ),
    );
    for (const c of r.contextFiles || []) {
      if (c.status === 'unchanged') continue;
      if (c.status === 'error') {
        say(warn(`    ${c.file}: ${c.error}`));
        continue;
      }
      say(dim(`    block ${c.status}  ${c.file}`));
    }
  }
  say(dim('\nIndexes rebuilt from the note files on disk. Hand edits are live.'));
  return 0;
}

/**
 * Every project the store knows about, paired with a working directory that
 * still exists. The registry records each cwd a slug has been seen at, so a
 * project cloned to a second checkout resolves to whichever copy is present.
 */
function everyProject(args) {
  const cfg = loadConfig({ root: args.root });
  const registry = loadRegistry(cfg.paths);
  let slugs;
  try {
    slugs = fs
      .readdirSync(cfg.paths.projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    slugs = Object.keys(registry.projects || {});
  }
  if (!slugs.length) slugs = [projectSlug(args.cwd)];

  const here = projectSlug(args.cwd);
  return slugs.map((slug) => {
    const known = registry.projects?.[slug]?.cwds || [];
    const live = known.find((d) => fs.existsSync(d));
    // No live directory means the index still gets rebuilt but no context file
    // is written — and never into *this* project, which is not that one.
    const cwd = live || (slug === here ? args.cwd : known[0] || path.join(cfg.paths.projectsDir, slug, 'missing-checkout'));
    return { slug, cwd };
  });
}

/* ----------------------------------------------------------- migrate ----- */

export async function migrate(args) {
  const ctx = open(args);
  const target = typeof args.flags.format === 'string' ? args.flags.format : null;

  if (target && !FORMATS.includes(target)) {
    throw new Error(`unknown format "${target}" — expected ${FORMATS.join(' | ')}`);
  }

  // 1. Schema upgrades. Nothing to do at v1, but the plumbing exists so a
  //    future format change is a migration, not a breaking release.
  //
  //    These go through the driver rather than `store.write`, because a
  //    migration must not touch `updated` — bumping it would silently reorder
  //    every note in the seed.
  const all = ctx.store.list({ scope: 'all', includeArchived: true });
  const stale = all.filter((n) => (n.v ?? 1) < SCHEMA_VERSION);
  if (stale.length) {
    for (const n of stale) ctx.store.driver.put({ ...n, v: SCHEMA_VERSION });
    ctx.reindex();
    say(ok(`Upgraded ${stale.length} notes to schema v${SCHEMA_VERSION}.`));
  }

  // 2. Format conversion.
  if (!target || target === ctx.store.format) {
    if (!stale.length) say(ok(`Nothing to migrate — schema v${SCHEMA_VERSION}, format ${ctx.store.format}.`));
    return 0;
  }

  say(`${bold(ctx.store.format)} ${dim(SYM.arrow)} ${bold(target)}  ${dim(`${all.length} notes`)}`);
  if (!(await confirm('Convert every note to the new format?', { yes: Boolean(args.flags.yes) }))) {
    say(gray('Cancelled.'));
    return 0;
  }

  // Write through a store opened on the target format, then flip the config.
  // The old files are left in place — deleting someone's only copy of their
  // memory to save disk space is not a trade worth making.
  const cfg = loadConfig({ root: args.root, slug: ctx.slug });
  const { openStore } = await import('../../store/index.mjs');
  const destination = openStore({ ...cfg, storage: { ...cfg.storage, format: target } }, {});
  destination.ensure();
  for (const n of all) destination.driver.put(n);

  const existing = readJsonSafe(cfg.paths.config, {}) || {};
  saveGlobalConfig({ ...existing, storage: { ...(existing.storage || {}), format: target } }, { root: args.root });

  const after = open(args);
  after.reindex();

  say(ok(`Converted ${all.length} notes to ${bold(target)}.`));
  say(dim(`  The old ${ctx.store.format} files are still there — remove them once you're happy.`));
  return 0;
}
