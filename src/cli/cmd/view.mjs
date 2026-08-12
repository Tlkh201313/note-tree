/**
 * `tree`, `export`, `seed`, `demo` — the commands that let you *see* memory.
 *
 * `seed` is the honest one: it prints the exact block a session receives and
 * what it costs, so the central claim of this project is one command away from
 * being checked rather than believed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from './_shared.mjs';
import { openContext } from '../../context.mjs';
import { renderSeed } from '../../seed.mjs';
import { PRESETS } from '../../config.mjs';
import { sessionStartEnvelope } from '../../agents/envelopes.mjs';
import { stageFor } from '../../theme.mjs';
import { say, ok, info, dim, bold, cyan, yellow, green, json, table, SYM } from '../out.mjs';

/* -------------------------------------------------------------- tree ----- */

export async function tree(args) {
  const ctx = open(args);
  const scope = args.flags.global ? 'global' : ctx.slug ? 'project' : 'global';
  const entries = scope === 'global' ? ctx.entries('global') : ctx.entries('project');

  if (args.flags.plain) {
    const { asciiTree } = await import('../../ui/ascii.mjs');
    say(asciiTree(entries, { title: scope === 'global' ? 'global memory' : ctx.slug }));
    return 0;
  }

  const { openTree } = await import('../../ui/launch.mjs');
  const shouldOpen = args.flags.open !== false && ctx.cfg.ui?.open !== false;
  const port = Number(args.flags.port) || ctx.cfg.ui?.port || 4747;

  const url = await openTree(ctx, { port, open: shouldOpen, scope });
  const live = entries.filter((n) => !n.archived).length;

  say('');
  say(`  ${green(SYM.leaf)} ${bold(url)}`);
  say(dim(`  ${live} note${live === 1 ? '' : 's'} ${SYM.dot} ${stageFor(live)} ${SYM.dot} ${scope}`));
  say('');
  say(dim('  Save a note from any terminal and watch the leaf sprout. Ctrl-C to stop.'));

  // The HTTP server holds the event loop open on its own; this just makes the
  // exit tidy instead of an abrupt kill mid-response.
  process.on('SIGINT', () => {
    say(dim('\n  Tree closed.'));
    process.exit(0);
  });
  return 0;
}

/* ------------------------------------------------------------ export ----- */

export async function exportTree(args) {
  const ctx = open(args);
  const { buildExport } = await import('../../ui/export.mjs');

  const built = buildExport(ctx, {
    scope: args.flags.global ? 'global' : null,
    forest: Boolean(args.flags.all),
    bodies: args.flags.bodies !== false,
  });

  const out = path.resolve(
    args.cwd,
    typeof args.flags.out === 'string' ? args.flags.out : 'tree.html',
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, built.html);

  if (args.json) return json({ file: out, bytes: built.bytes, counts: built.counts }), 0;

  say(ok(`${bold(path.relative(args.cwd, out) || out)}  ${dim(`${(built.bytes / 1024).toFixed(0)} KB`)}`));
  say(
    dim(
      `  ${built.counts.project} project + ${built.counts.global} global notes` +
        `${args.flags.all ? ` across ${built.counts.projects} projects` : ''}`,
    ),
  );
  say(dim('  Self-contained: open it with networking off, or publish it as a demo.'));
  return 0;
}

/* -------------------------------------------------------------- seed ----- */

export async function seed(args) {
  const ctx = open(args);

  const preset = typeof args.flags.verbosity === 'string' ? args.flags.verbosity : null;
  if (preset && !PRESETS[preset]) {
    throw new Error(`unknown verbosity "${preset}" — expected ${Object.keys(PRESETS).join(' | ')}`);
  }

  // Previewing a preset must not save it. Build a throwaway config instead of
  // touching the one on disk.
  const cfg = preset
    ? { ...ctx.cfg, verbosity: preset, budget: { ...ctx.cfg.budget, ...PRESETS[preset] } }
    : ctx.cfg;

  const agent = typeof args.flags.agent === 'string' ? args.flags.agent : null;
  const rendered = renderSeed(ctx.entries('project'), ctx.entries('global'), cfg, { project: ctx.slug });

  const envelope = agent ? sessionStartEnvelope(agent, rendered?.text || '', cfg.hooks?.injectionMode || 'auto') : null;

  if (args.json) {
    return json({
      verbosity: cfg.verbosity,
      cap: cfg.budget.maxSeedChars,
      seed: rendered
        ? { text: rendered.text, chars: rendered.chars, tokens: rendered.tokens, counts: rendered.counts, truncated: rendered.truncated }
        : null,
      agent,
      envelope,
      envelopeChars: envelope ? envelope.length : null,
    }), 0;
  }

  if (!rendered) {
    say(info(dim('Nothing to inject yet — an empty tree costs exactly zero tokens.')));
    say(dim('  Save the first note with `note-tree add "…"`.'));
    return 0;
  }

  say('');
  say(dim(rendered.text));
  say('');

  const rows = [
    ['preset', `${cfg.verbosity}${preset ? dim('  (preview only — not saved)') : ''}`],
    ['size', `${cyan(`~${rendered.tokens} tokens`)} ${dim(`${rendered.chars} / ${cfg.budget.maxSeedChars} chars`)}`],
    ['notes', `${rendered.counts.rendered} shown ${dim(`(${rendered.counts.project} project, ${rendered.counts.global} global)`)}`],
  ];
  if (rendered.truncated) rows.push(['trimmed', yellow(`${rendered.counts.dropped} lowest-ranked notes did not fit`)]);
  if (agent) {
    rows.push([
      `${agent} envelope`,
      envelope ? `${envelope.length} chars ${dim(envelope.startsWith('{') ? 'JSON hookSpecificOutput' : 'plain stdout')}` : dim('none'),
    ]);
  }
  say(table(rows.map(([k, v]) => [dim(k), v]), { columns: [{ header: '' }, { header: '', flex: true }] }));
  say('');
  say(dim('  This is the whole session cost. Nothing else is injected at startup.'));
  return 0;
}

/* -------------------------------------------------------------- demo ----- */

export async function demo(args) {
  const wanted = Math.max(1, Math.min(Number(args.flags.notes) || 40, 400));
  const keep = Boolean(args.flags.keep);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-tree-demo-'));
  const workdir = path.join(root, 'orchard-api');
  fs.mkdirSync(workdir, { recursive: true });

  // A temporary root, always: a demo must never mix sample notes into the
  // memory someone actually relies on.
  const ctx = openContext({ cwd: workdir, root, slug: 'orchard-api', agent: 'demo', withProject: true });
  ctx.store.ensure();

  for (const note of sampleNotes(wanted)) {
    try {
      ctx.store.write(note, { project: ctx.slug }, { force: true });
    } catch {
      /* one unusable sample shouldn't cost you the demo */
    }
  }
  ctx.reindex();

  const cleanup = () => {
    if (keep) return;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* a temp directory left behind is not worth a crash on exit */
    }
  };

  const live = ctx.allEntries().filter((n) => !n.archived).length;
  const seedText = ctx.seed();

  say('');
  say(`  ${green(SYM.leaf)} ${bold('note-tree demo')} ${dim(`${SYM.dot} ${live} sample notes ${SYM.dot} ${stageFor(live)}`)}`);
  say(
    dim(
      `  A real session would receive ${seedText ? `~${seedText.tokens} tokens` : 'nothing'} of this` +
        ` — not the ${Math.round(charTotal(ctx) / 1024)} KB the notes actually hold.`,
    ),
  );
  say('');

  if (args.flags.open === false) {
    const { buildExport } = await import('../../ui/export.mjs');
    const out = path.resolve(args.cwd, 'note-tree-demo.html');
    fs.writeFileSync(out, buildExport(ctx, { scope: 'all' }).html);
    cleanup();
    say(ok(`Wrote ${bold(path.relative(args.cwd, out) || out)} — open it in any browser.`));
    return 0;
  }

  const { openTree } = await import('../../ui/launch.mjs');
  const url = await openTree(ctx, { port: Number(args.flags.port) || 4747, open: true, scope: 'all' });

  say(`  ${bold(url)}`);
  say('');
  say(dim('  Hover a leaf for its name and date. Click for the full note.'));
  say(dim(keep ? `  Demo store kept at ${root}` : '  Ctrl-C to stop — the sample store is deleted on exit.'));

  process.on('SIGINT', () => {
    cleanup();
    say(dim('\n  Demo closed.'));
    process.exit(0);
  });
  process.on('exit', cleanup);
  return 0;
}

function charTotal(ctx) {
  return ctx.store
    .list({ scope: 'all', includeArchived: true })
    .reduce((sum, n) => sum + (n.body?.length || 0) + (n.title?.length || 0), 0);
}

/* ------------------------------------------------------------------ *
 * Sample data
 *
 * Written out longhand rather than generated from noise, because the demo is
 * the pitch: someone deciding whether this is worth installing should see notes
 * that look like the ones they'd actually want back.
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;

const SAMPLES = [
  {
    kind: 'gotcha',
    title: 'Pagination is cursor-based, not offset',
    desc: 'The /orchards endpoint ignores ?page and silently returns page 1.',
    tags: ['api', 'pagination'],
    body:
      'Every list endpoint takes `?cursor=` and returns `next_cursor`. Passing `?page=2` is not an error — it is ignored, and you get page 1 again, which looks like a caching bug for about an hour.\n\nUse the cursor from the previous response, and stop when `next_cursor` is null.',
  },
  {
    kind: 'decision',
    title: 'We store timestamps as UTC ISO strings, never epoch integers',
    desc: 'Readability in the store beat 8 bytes per row; reversed in 2024 and regretted.',
    tags: ['data', 'time'],
    body:
      'Notes, events and audit rows all use `2026-01-04T09:12:00Z`. We tried epoch millis for a quarter; every debugging session started with a conversion, and two bugs came from seconds-vs-millis confusion.\n\nIf you need to sort, ISO-8601 UTC sorts lexicographically anyway.',
  },
  {
    kind: 'architecture',
    title: 'The worker never talks to the database directly',
    desc: 'All writes go through the API so validation and audit live in one place.',
    tags: ['workers', 'boundaries'],
    body:
      'Background jobs call the same HTTP API as clients, with a service token. It costs a round trip and buys a single validation path, one audit log, and the ability to change the schema without redeploying workers in lockstep.',
  },
  {
    kind: 'convention',
    title: 'Migrations are additive for one release, destructive in the next',
    desc: 'Add the column, backfill, ship, then drop the old one — never in one deploy.',
    tags: ['db', 'migrations'],
    body:
      'A deploy is never atomic across instances, so old and new code run side by side for a few minutes. Anything that drops or renames in the same release as the code change causes a short window of 500s.',
  },
  {
    kind: 'preference',
    title: 'Prefer explaining the why in the PR body, not in comments',
    desc: 'Code comments say what is surprising; PRs carry the reasoning and alternatives.',
    tags: ['review'],
    body:
      'Comments age with the line they sit on. Reasoning about alternatives belongs where it stays findable and dated: the pull request, linked from the commit.',
  },
  {
    kind: 'gotcha',
    title: 'The test suite needs a fake HOME, not just a temp data dir',
    desc: 'Adapters resolve config paths from os.homedir() at import time.',
    tags: ['testing'],
    body:
      'Redirecting the data root is not enough: anything that resolves `~/.config` does so from `os.homedir()`, which reads `USERPROFILE`/`HOME` when the process starts. Set both in the test harness, or a test run edits your real settings.',
  },
  {
    kind: 'decision',
    title: 'No background daemon, ever',
    desc: 'Startup cost must be one process that exits, not a service that lingers.',
    tags: ['performance'],
    body:
      'A resident worker means a port, a lifecycle, a crash path and a thing to explain in the README. Everything here is designed so the hot path is a single short-lived process reading one JSON file.',
  },
  {
    kind: 'reference',
    title: 'Staging credentials live in 1Password, vault "Orchard / staging"',
    desc: 'Rotated monthly; the CI copy is a separate service account.',
    tags: ['ops', 'secrets'],
    body: 'Ask in #orchard-eng for access. CI does not use these — it has its own account with read-only scope.',
  },
  {
    kind: 'convention',
    title: 'Error responses always carry a stable `code`',
    desc: 'Clients switch on `code`, never on the human-readable `message`.',
    tags: ['api', 'errors'],
    body:
      '`{"code":"orchard.not_found","message":"…"}`. The message is free to change and is translated; the code is part of the contract and needs a deprecation cycle.',
  },
  {
    kind: 'gotcha',
    title: 'Windows paths need lowercasing before hashing',
    desc: 'C:\\Foo and c:\\foo are the same directory but hash differently.',
    tags: ['windows', 'paths'],
    body:
      'Any identifier derived from an absolute path has to normalise case on Windows, or the same folder gets two identities depending on how the shell spelled it that day.',
  },
  {
    kind: 'architecture',
    title: 'Search is trigram-based, not embeddings',
    desc: 'Good enough for a few thousand short records, and it has no model to load.',
    tags: ['search'],
    body:
      'Titles and tags are matched with a Dice coefficient over character trigrams. It handles typos, needs no index build, and adds nothing to startup. Semantic search is a roadmap item, not a dependency.',
  },
  {
    kind: 'todo',
    title: 'Rate-limit headers are missing on the batch endpoint',
    desc: 'Clients back off blind; add X-RateLimit-* the way the single endpoint does.',
    tags: ['api', 'todo'],
    body: 'Single-resource endpoints return the standard trio. `/batch` returns none, so clients guess. Low effort, high annoyance.',
  },
  {
    kind: 'decision',
    title: 'Ship the CLI as one file with zero dependencies',
    desc: 'Install time and supply-chain surface both go to roughly zero.',
    tags: ['packaging'],
    body:
      'No dependencies means no install step, no native build, no audit noise, and a cold start dominated by Node itself. It costs us a few hundred lines of utility code, which we would have read anyway.',
  },
  {
    kind: 'preference',
    title: 'Small PRs, even when the refactor is obviously right',
    desc: 'Review quality falls off a cliff past about 400 changed lines.',
    tags: ['review', 'process'],
    body: 'Land the mechanical change on its own, then the behavioural one. Two boring reviews beat one that gets a thumbs-up nobody earned.',
  },
  {
    kind: 'gotcha',
    title: 'SSE through the office proxy dies silently after 30s',
    desc: 'Send a comment keepalive at least every 25 seconds.',
    tags: ['sse', 'networking'],
    body: 'The connection stays open from the client\'s point of view but no events arrive. A `: ping` comment line every 25s keeps it alive and costs nothing.',
    scope: 'global',
  },
  {
    kind: 'convention',
    title: 'Branch names: type/short-description, no ticket numbers',
    desc: 'Tickets move; the branch name should still say what it does in a year.',
    tags: ['git'],
    body: 'fix/cursor-pagination, feat/batch-endpoint, chore/node-24. The ticket goes in the PR description where it can be updated.',
    scope: 'global',
  },
  {
    kind: 'preference',
    title: 'Ask before changing anything outside the current task',
    desc: 'Adjacent cleanup is welcome as a follow-up, not as a surprise in the diff.',
    tags: ['working-style'],
    body: 'If you spot something worth fixing while you are in there, note it and mention it. A diff that does two things is a diff that gets reviewed as one.',
    scope: 'global',
  },
  {
    kind: 'reference',
    title: 'Runbook: what to do when the queue backs up',
    desc: 'Check consumer lag first, then the poison-message table, then scale.',
    tags: ['ops', 'runbook'],
    body:
      '1. Consumer lag per partition in the dashboard.\n2. `orchard-admin poison list` — one bad message can stall a partition.\n3. Only then add consumers; scaling past a stuck message just adds idle workers.',
    scope: 'global',
  },
];

/**
 * Spread the samples across sessions and weeks, so the demo tree has the shape
 * a real one does: bursts of activity, quiet stretches, two agents.
 *
 * Exported because scripts/hero.mjs renders the README picture from the same
 * corpus — the demo and the advertisement should never be different trees.
 */
export function sampleNotes(count) {
  const now = Date.now();
  const sessions = Math.max(3, Math.min(14, Math.ceil(count / 3.5)));
  const out = [];

  for (let i = 0; i < count; i++) {
    const base = SAMPLES[i % SAMPLES.length];
    const round = Math.floor(i / SAMPLES.length);
    const s = Math.floor((i / count) * sessions);

    // Oldest first, tightening towards today — recent work is denser.
    const daysAgo = 42 * (1 - s / sessions) ** 1.6;
    const created = new Date(now - daysAgo * DAY - (i % 5) * 47 * 60_000).toISOString();

    out.push({
      ...base,
      title: round ? `${base.title} (${round + 1})` : base.title,
      scope: base.scope || 'project',
      session: `demo-${String(s).padStart(2, '0')}`,
      agent: s % 3 === 2 ? 'codex' : 'claude',
      created,
      updated: created,
      reads: (i * 7) % 9,
      pinned: i % 11 === 3,
      archived: i > 6 && i % 17 === 0,
    });
  }
  return out;
}
