/**
 * `init`, `adapters`, `uninstall` — everything that touches another tool's
 * configuration.
 *
 * `init` is the command that has to earn trust in ten seconds: it says what it
 * found, what it changed, and what to do next, and it never writes anything it
 * didn't name.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, byId, bestTier, detectInstalled } from '../../agents/registry.mjs';
import { wire, unwire, inspect, PLUGIN_ROOT } from '../../agents/wire.mjs';
import { removeContextFile } from '../../agents/contextfile.mjs';
import { PRESETS, loadConfig, saveGlobalConfig, readJsonSafe } from '../../config.mjs';
import { projectSlug } from '../../paths.mjs';
import { open } from './_shared.mjs';
import { many } from '../args.mjs';
import {
  say, ok, warn, info, fail, dim, bold, gray, green, yellow, json,
  table, confirm, SYM,
} from '../out.mjs';

/* -------------------------------------------------------------- init ----- */

export async function init(args) {
  const { flags } = args;
  const dryRun = Boolean(flags['dry-run']);
  const slug = projectSlug(args.cwd);

  say('');
  say(`${bold(green('note-tree'))} ${dim(SYM.leaf)} ${dim('setting up memory for')} ${bold(path.basename(args.cwd))}`);

  // 1. Which CLIs are we wiring?
  const requested = many(flags.agent);
  const wantAll = requested.includes('all');
  const detected = detectInstalled((p) => fs.existsSync(p), args.cwd);
  let targets = wantAll
    ? ADAPTERS
    : requested.length
      ? requested.map((id) => byId(id) || fail(`Unknown agent "${id}"`) || null).filter(Boolean)
      : detected;

  if (!targets.length) {
    say('');
    say(warn('No agent CLIs detected here.'));
    say(dim('  Wire one explicitly:  note-tree init --agent claude'));
    say(dim(`  Supported: ${ADAPTERS.map((a) => a.id).join(', ')}`));
    return 1;
  }

  // 2. Store settings — only written when asked, so re-running init is safe.
  const patch = {};
  if (typeof flags.verbosity === 'string') {
    if (!PRESETS[flags.verbosity]) throw new Error(`verbosity must be ${Object.keys(PRESETS).join(' | ')}`);
    patch.verbosity = flags.verbosity;
  }
  if (typeof flags.format === 'string') patch.storage = { format: flags.format };

  const cfg = loadConfig({ root: args.root, slug });
  const enabled = new Set([...(cfg.agents?.enabled || []), ...targets.map((a) => a.id)]);
  patch.agents = { enabled: [...enabled] };

  if (!dryRun) {
    const existing = readJsonSafe(cfg.paths.config, {}) || {};
    saveGlobalConfig({ ...existing, ...patch }, { root: args.root });
    open(args).store.ensure();
  }

  // 3. Wire each adapter.
  const nodeBin = flags['absolute-node'] ? process.execPath.split(path.sep).join('/') : 'node';
  const results = [];
  for (const adapter of targets) {
    results.push(
      wire(adapter.id, {
        cwd: args.cwd,
        pluginRoot: PLUGIN_ROOT,
        backups: cfg.paths.backups,
        nodeBin,
        dryRun,
        hooks: flags.hooks !== false,
        mcp: flags.mcp !== false,
      }),
    );
  }

  // 4. Tier B blocks for adapters that read a file rather than run a hook.
  let contextResults = [];
  if (!dryRun) {
    const ctx = open(args);
    ctx.cfg.agents.enabled = [...enabled];
    contextResults = ctx.refreshContextFiles({ force: true });
  }

  if (args.json) {
    return json({ slug, agents: results, contextFiles: contextResults, dryRun }), 0;
  }

  // 5. Report — grouped by agent, one line per file we touched.
  say('');
  for (const r of results) {
    const adapter = byId(r.agent);
    const label = `${bold(adapter.name)} ${dim(`tier ${bestTier(adapter)}`)}`;
    const flag = adapter.confidence === 'community' ? ` ${yellow('experimental')}` : '';
    say(`  ${detected.includes(adapter) ? green(SYM.ok) : dim(SYM.dot)} ${label}${flag}`);

    for (const a of r.actions) {
      if (a.status === 'error') {
        say(`      ${yellow(SYM.warn)} ${a.error}`);
        continue;
      }
      const verb = { created: 'wrote', updated: 'updated', unchanged: 'already set' }[a.status] || a.status;
      const kind = { hook: 'hooks', mcp: 'mcp  ', skill: 'skill' }[a.kind] || a.kind;
      say(`      ${dim(`${kind} ${verb}`)} ${dim(short(a.file, args.cwd))}${a.backup ? dim(`  (backed up)`) : ''}`);
    }
    for (const c of contextResults.filter((c) => c.agent === adapter.id)) {
      // An empty tree renders no block at all — that's the point, a session
      // with nothing to remember should cost nothing.
      if (c.status === 'absent' || c.status === 'deleted') {
        say(`      ${dim('block')} ${dim('appears with your first note')}`);
        continue;
      }
      const verb = { created: 'wrote', updated: 'updated', unchanged: 'already set' }[c.status] || c.status;
      say(`      ${dim(`block ${verb}`)} ${dim(short(c.file, args.cwd))}`);
    }
  }

  const errors = results.flatMap((r) => r.actions).filter((a) => a.status === 'error');
  say('');
  if (dryRun) {
    say(info(gray('Dry run — nothing was written.')));
    return 0;
  }
  if (errors.length) say(warn(`${errors.length} file${errors.length === 1 ? '' : 's'} needed attention (above).`));

  say(ok(`Memory is live for ${bold(slug)}.`));
  say('');
  say(dim('  Try it:'));
  say(`    ${dim('$')} note-tree add "something worth remembering" --kind decision`);
  say(`    ${dim('$')} note-tree seed        ${dim('# exactly what a session will receive')}`);
  say(`    ${dim('$')} note-tree tree        ${dim('# watch it grow')}`);
  const hooked = targets.filter((a) => a.hook);
  if (hooked.length) {
    say('');
    say(dim(`  ${hooked.map((a) => a.name).join(' and ')} will pick this up on the next session you start.`));
  }
  return errors.length ? 1 : 0;
}

/** Paths inside the project read better as `./AGENTS.md` than as 90 characters. */
function short(file, cwd) {
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return `./${rel.split(path.sep).join('/')}`;
}

/* ---------------------------------------------------------- adapters ----- */

export async function adapters(args) {
  const cfg = loadConfig({ root: args.root, slug: projectSlug(args.cwd) });
  const enabled = new Set(cfg.agents?.enabled || []);
  const rows = [];

  for (const a of ADAPTERS) {
    const installed = (a.detect || []).some((d) =>
      fs.existsSync(path.isAbsolute(d) ? d : path.join(args.cwd, d)),
    );
    const state = inspect(a.id, { cwd: args.cwd });
    const wiredBits = [
      state?.hook?.wired ? 'hooks' : null,
      state?.mcp?.wired ? 'mcp' : null,
      enabled.has(a.id) && a.contextFile && !a.contextFile.fallbackOnly ? 'block' : null,
    ].filter(Boolean);

    rows.push({
      id: a.id,
      name: a.name,
      tiers: a.tiers.join(''),
      confidence: a.confidence,
      installed,
      wired: wiredBits,
      note: a.note || null,
    });
  }

  if (args.json) return json(rows), 0;

  say(bold('Agent CLIs'));
  say('');
  say(
    table(
      rows.map((r) => [
        r.installed ? green(SYM.ok) : dim(SYM.dot),
        r.wired.length ? green(r.id) : r.id,
        dim(r.tiers),
        r.wired.length ? r.wired.join(' + ') : dim('not wired'),
        r.confidence === 'community' ? yellow('experimental') : dim('verified'),
      ]),
      {
        columns: [
          { header: '' },
          { header: 'agent' },
          { header: 'tiers' },
          { header: 'wired', flex: true },
          { header: '' },
        ],
      },
    ),
  );

  const notes = rows.filter((r) => r.note);
  if (notes.length) {
    say('');
    for (const r of notes) say(dim(`  ${r.id}: ${r.note}`));
  }
  say('');
  say(dim(`  ${green(SYM.ok)} = detected on this machine   ·   tiers: A hook, B context block, C mcp`));
  say(dim('  note-tree init --agent <id>'));
  return 0;
}

/* --------------------------------------------------------- uninstall ----- */

export async function uninstall(args) {
  const slug = projectSlug(args.cwd);
  const cfg = loadConfig({ root: args.root, slug });

  say(bold('This will remove note-tree from:'));
  const touched = ADAPTERS.filter((a) => {
    const s = inspect(a.id, { cwd: args.cwd });
    return s?.hook?.wired || s?.mcp?.wired || s?.skill?.present || s?.commands?.present;
  });
  for (const a of touched) say(`  ${dim(SYM.dot)} ${a.name}`);
  const blocks = ADAPTERS.filter((a) => a.contextFile && !a.contextFile.fallbackOnly)
    .map((a) => (path.isAbsolute(a.contextFile.file) ? a.contextFile.file : path.join(args.cwd, a.contextFile.file)))
    .filter((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('note-tree:start'));
  for (const f of blocks) say(`  ${dim(SYM.dot)} generated block in ${short(f, args.cwd)}`);

  if (!touched.length && !blocks.length) {
    say(gray('Nothing to remove — note-tree isn’t wired into anything here.'));
    return 0;
  }

  const purge = Boolean(args.flags.purge);
  say('');
  say(purge ? yellow(`Your notes in ${cfg.paths.root} will be DELETED.`) : dim(`Your notes in ${cfg.paths.root} will be kept.`));

  if (!(await confirm('Continue?', { yes: Boolean(args.flags.yes) }))) {
    say(gray('Cancelled.'));
    return 0;
  }

  for (const a of touched) {
    const r = unwire(a.id, { cwd: args.cwd, backups: cfg.paths.backups });
    for (const act of r.actions) {
      if (act.status === 'error') say(warn(`${a.id}: ${act.error}`));
    }
  }
  for (const f of blocks) removeContextFile(f);

  if (purge) {
    fs.rmSync(cfg.paths.root, { recursive: true, force: true });
    say(ok('Removed note-tree and deleted the note store.'));
  } else {
    say(ok('Unwired. Your notes are still in ' + cfg.paths.root + '.'));
    say(dim('  Re-wire any time with `note-tree init`.'));
  }
  return 0;
}
