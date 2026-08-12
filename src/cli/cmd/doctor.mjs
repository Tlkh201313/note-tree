/**
 * `note-tree doctor` — does this actually work on *this* machine?
 *
 * Every claim note-tree makes is checked by running the real thing, not by
 * inspecting intent: the hot path is spawned as a subprocess with a real
 * SessionStart payload and timed; wiring is read back out of each CLI's own
 * config file; the generated block is compared against what the store would
 * render right now.
 *
 * Checks report one of `pass` | `warn` | `fail`, and `--fix` repairs the ones
 * that are repairable. A `warn` never means broken — it means "worth knowing".
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from './_shared.mjs';
import { ADAPTERS, byId, bestTier, detectInstalled } from '../../agents/registry.mjs';
import { inspect, wire, PLUGIN_ROOT } from '../../agents/wire.mjs';
import { START, END } from '../../agents/contextfile.mjs';
import { isStale, loadIndex } from '../../index-cache.mjs';
import { SEED_HARD_CAP } from '../../config.mjs';
import { size as journalSize } from '../../journal.mjs';
import { many } from '../args.mjs';
import {
  say, dim, bold, gray, green, yellow, red, cyan, json, table, wrap, SYM, confirm,
} from '../out.mjs';

const HOT_PATH_BUDGET_MS = 150;
const HOOK_OUTPUT_CAP = 10_000;

export async function doctor(args) {
  const ctx = open(args);
  const only = many(args.flags.agent);
  const checks = [];
  const add = (c) => (checks.push(c), c);

  /* ---------------------------------------------------------- runtime --- */

  const major = Number(process.versions.node.split('.')[0]);
  add({
    group: 'Runtime',
    name: 'Node version',
    status: major >= 18 ? 'pass' : 'fail',
    detail: `v${process.versions.node}`,
    hint: major >= 18 ? null : 'note-tree needs Node 18 or newer.',
  });

  const onPath = await which('node');
  add({
    group: 'Runtime',
    name: '`node` on PATH',
    status: onPath ? 'pass' : 'warn',
    detail: onPath || 'not resolvable',
    hint: onPath
      ? null
      : 'Editors launched from a desktop icon can have a thinner PATH. Re-run `note-tree init --absolute-node` to bake in this interpreter.',
  });

  add({
    group: 'Runtime',
    name: 'Install location',
    status: fs.existsSync(path.join(PLUGIN_ROOT, 'mcp', 'server.mjs')) ? 'pass' : 'fail',
    detail: PLUGIN_ROOT,
    hint: 'Wiring points at this path — moving the install means re-running `note-tree init`.',
  });

  /* ------------------------------------------------------------ store --- */

  const stats = ctx.store.stats();
  add({
    group: 'Store',
    name: 'Note store',
    status: 'pass',
    detail: `${stats.total} note${stats.total === 1 ? '' : 's'} ${dim(`(${stats.archived} archived)`)} ${dim(SYM.dot)} ${stats.format} ${dim(SYM.dot)} ${ctx.paths.root}`,
  });

  const scopes = ctx.paths.projectDir ? ['project', 'global'] : ['global'];
  const staleScopes = scopes.filter((s) => isStale(ctx.paths, s, stats.format, loadIndex(ctx.paths, s)));
  add({
    group: 'Store',
    name: 'Index freshness',
    status: staleScopes.length ? 'warn' : 'pass',
    detail: staleScopes.length ? `${staleScopes.join(' and ')} index out of date` : 'up to date',
    hint: staleScopes.length ? 'The next session repairs this automatically; `note-tree sync` does it now.' : null,
    fix: staleScopes.length ? () => ctx.reindex() && 'index rebuilt' : null,
  });

  const jbytes = journalSize(ctx.paths.journal);
  add({
    group: 'Store',
    name: 'Journal',
    status: jbytes > 20 * 1024 * 1024 ? 'warn' : 'pass',
    detail: ctx.cfg.storage?.journal === false ? dim('disabled') : `${fmtBytes(jbytes)}`,
    hint: jbytes > 20 * 1024 * 1024 ? 'Large journals only slow the growth animation. Safe to truncate.' : null,
  });

  /* ------------------------------------------------------------- seed --- */

  const seed = ctx.seed();
  const cap = Math.min(ctx.cfg.budget?.maxSeedChars ?? SEED_HARD_CAP, SEED_HARD_CAP);
  add({
    group: 'Session cost',
    name: 'Seed size',
    status: !seed ? 'warn' : seed.chars > HOOK_OUTPUT_CAP ? 'fail' : 'pass',
    detail: seed
      ? `${cyan(`~${seed.tokens} tokens`)} ${dim(`(${seed.chars}/${cap} chars, ${seed.counts.rendered} notes${seed.truncated ? `, ${seed.counts.dropped} trimmed by rank` : ''})`)}`
      : dim('nothing to inject — no notes yet'),
    hint: !seed
      ? 'Add one with `note-tree add "…"`, or let your agent write the first note.'
      : seed.chars > HOOK_OUTPUT_CAP
        ? `Above the 10,000-char hook limit. Lower budget.maxSeedChars.`
        : null,
  });

  /* --------------------------------------------------------- hot path --- */

  const hot = await timeHotPath(ctx, args);
  add({
    group: 'Session cost',
    name: 'SessionStart latency',
    status: hot.error ? 'fail' : hot.ms > HOT_PATH_BUDGET_MS * 2 ? 'warn' : 'pass',
    detail: hot.error ? hot.error : `${hot.ms} ms ${dim(`(budget ${HOT_PATH_BUDGET_MS} ms)`)}`,
    hint: hot.error ? 'The hook could not run — sessions will simply start without memory.' : null,
  });

  if (!hot.error) {
    // Bug anthropics/claude-code#16538: `additionalContext` from a plugin is
    // sometimes dropped. What we can verify here is that we emit exactly one
    // well-formed envelope — emitting both JSON and text would double-inject.
    const shape = envelopeShape(hot.stdout);
    add({
      group: 'Session cost',
      name: 'Hook envelope',
      status: shape.ok ? 'pass' : 'fail',
      detail: shape.label,
      hint: shape.ok
        ? null
        : 'Set hooks.injectionMode to "json" or "text" to pin the shape: note-tree config set hooks.injectionMode json',
    });
    if (hot.stderr.trim()) {
      add({
        group: 'Session cost',
        name: 'Hook stderr',
        status: 'warn',
        detail: hot.stderr.trim().split('\n')[0],
        hint: 'Hooks are fail-open, so this did not break the session — but it should be empty.',
      });
    }
  }

  /* ----------------------------------------------------------- agents --- */

  const detected = detectInstalled((p) => fs.existsSync(p), args.cwd);
  const targets = only.length
    ? only.map((id) => byId(id)).filter(Boolean)
    : ADAPTERS.filter((a) => detected.includes(a) || (ctx.cfg.agents?.enabled || []).includes(a.id));

  if (!targets.length) {
    add({
      group: 'Agents',
      name: 'Wiring',
      status: 'warn',
      detail: 'no agent CLIs wired here',
      hint: 'Run `note-tree init` in this project.',
    });
  }

  for (const adapter of targets) {
    const state = inspect(adapter.id, { cwd: args.cwd });
    const enabled = (ctx.cfg.agents?.enabled || []).includes(adapter.id);
    const bits = [];
    let status = 'pass';

    if (adapter.hook) {
      bits.push(state.hook.wired ? green('hooks') : dim('hooks'));
      if (!state.hook.wired) status = enabled ? 'warn' : 'warn';
    }
    if (adapter.mcp) bits.push(state.mcp.wired ? green('mcp') : dim('mcp'));

    const blockCheck = adapter.contextFile && !adapter.contextFile.fallbackOnly ? checkBlock(ctx, adapter, args.cwd) : null;
    if (blockCheck) {
      bits.push(blockCheck.status === 'pass' ? green('block') : blockCheck.status === 'warn' ? yellow('block') : dim('block'));
      if (blockCheck.status === 'warn' && status === 'pass') status = 'warn';
    }

    const anyWired = state.hook?.wired || state.mcp?.wired || blockCheck?.present;
    if (!anyWired) status = enabled ? 'fail' : 'warn';

    add({
      group: 'Agents',
      name: adapter.name,
      status,
      detail: `${bits.join(' + ') || dim('nothing wired')}  ${dim(`tier ${bestTier(adapter)}`)}${adapter.confidence === 'community' ? ` ${yellow('experimental')}` : ''}`,
      hint: !anyWired
        ? `note-tree init --agent ${adapter.id}`
        : blockCheck?.status === 'warn'
          ? blockCheck.hint
          : null,
      fix: !anyWired || blockCheck?.status === 'warn'
        ? () => {
            wire(adapter.id, { cwd: args.cwd, pluginRoot: PLUGIN_ROOT, backups: ctx.paths.backups });
            ctx.cfg.agents.enabled = [...new Set([...(ctx.cfg.agents?.enabled || []), adapter.id])];
            ctx.refreshContextFiles({ force: true });
            return `${adapter.id} re-wired`;
          }
        : null,
    });
  }

  /* ---------------------------------------------------------- overlap --- */

  for (const file of ['MEMORY.md', 'CLAUDE.md']) {
    const full = path.join(args.cwd, file);
    let bytes = 0;
    try {
      bytes = fs.statSync(full).size;
    } catch {
      continue;
    }
    // Claude Code's own Auto Memory loads this whole file every session. That's
    // fine — but you shouldn't pay for the same knowledge twice without knowing.
    const heavy = bytes > 4000;
    add({
      group: 'Overlap',
      name: file,
      status: heavy ? 'warn' : 'pass',
      detail: `${fmtBytes(bytes)} ${dim(`~${Math.ceil(bytes / 4)} tokens, loaded every session`)}`,
      hint: heavy ? `That is more than note-tree's entire budget. \`note-tree import --from ${file === 'MEMORY.md' ? 'memory-md' : 'claude-md'}\` folds it in.` : null,
    });
  }

  /* ------------------------------------------------------------ fixes --- */

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');

  if (args.flags.fix) {
    const fixable = checks.filter((c) => c.fix && c.status !== 'pass');
    if (fixable.length && (await confirm(`Apply ${fixable.length} fix${fixable.length === 1 ? '' : 'es'}?`, { yes: Boolean(args.flags.yes), fallback: true }))) {
      for (const c of fixable) {
        try {
          c.fixed = c.fix() || 'repaired';
        } catch (error) {
          c.fixed = `could not repair: ${error.message}`;
        }
      }
    }
  }

  if (args.json) {
    return json({
      ok: !failed.length,
      project: ctx.slug,
      checks: checks.map(({ fix, ...c }) => ({ ...c, detail: strip(c.detail), hint: c.hint || null })),
    }), failed.length ? 1 : 0;
  }

  /* ----------------------------------------------------------- report --- */

  let group = null;
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      say(`\n${bold(group)}`);
    }
    say(`  ${mark(c.status)} ${pad20(trim(c.name, 21))} ${c.detail ?? ''}`);
    // Hints are advice for something that needs attention. A passing check that
    // still explains itself is just noise on every run.
    if (c.fixed) say(`      ${green(SYM.arrow)} ${c.fixed}`);
    else if (c.hint && c.status !== 'pass') say(dim(wrap(c.hint, 78, '      ')));
  }

  say('');
  if (failed.length) {
    say(`${red(SYM.err)} ${bold(`${failed.length} problem${failed.length === 1 ? '' : 's'}`)}${warned.length ? dim(`, ${warned.length} worth a look`) : ''}`);
    if (!args.flags.fix && checks.some((c) => c.fix)) say(dim('  Try `note-tree doctor --fix`.'));
    return 1;
  }
  if (warned.length) {
    say(`${green(SYM.ok)} ${bold('Working')} ${dim(`— ${warned.length} thing${warned.length === 1 ? '' : 's'} worth a look above`)}`);
    return 0;
  }
  say(`${green(SYM.ok)} ${bold('Everything checks out.')} ${dim(seed ? `~${seed.tokens} tokens per session, ${hot.ms} ms to load.` : '')}`);
  return 0;
}

/* ------------------------------------------------------------------------ */

/**
 * Run the real hook, the way the agent runs it — a subprocess fed a real
 * payload on stdin. Timing it in-process would measure a warm module cache and
 * report a number no user will ever see.
 */
function timeHotPath(ctx, args) {
  const hookPath = path.join(PLUGIN_ROOT, 'hooks', 'session-start.mjs');
  if (!fs.existsSync(hookPath)) return Promise.resolve({ ms: 0, stdout: '', stderr: '', error: `missing ${hookPath}` });

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [hookPath, '--agent', 'claude'], {
      cwd: args.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // `--root` has to reach the subprocess, and the hook takes no such flag.
      env: { ...process.env, ...(args.root ? { NOTE_TREE_HOME: args.root } : {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ ms: 0, stdout, stderr, error: error.message }));
    child.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({
        ms: Math.round(ms),
        stdout,
        stderr,
        error: code === 0 ? null : `hook exited ${code}`,
      });
    });
    // A session-start payload as Claude Code sends it.
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: args.cwd, session_id: 'doctor' }));
  });
}

/** Exactly one well-formed envelope, or we say so. */
function envelopeShape(stdout) {
  const text = stdout.trim();
  if (!text) return { ok: true, label: dim('empty — nothing to inject yet') };
  if (text.length > HOOK_OUTPUT_CAP) return { ok: false, label: `${text.length} chars — over the 10,000-char hook cap` };
  if (text.startsWith('{')) {
    try {
      const doc = JSON.parse(text);
      const ctxText = doc?.hookSpecificOutput?.additionalContext;
      if (typeof ctxText !== 'string' || !ctxText) return { ok: false, label: 'JSON without additionalContext' };
      if (doc.hookSpecificOutput.hookEventName !== 'SessionStart') return { ok: false, label: 'JSON missing hookEventName' };
      return { ok: true, label: `${green('JSON')} ${dim(`hookSpecificOutput.additionalContext, ${ctxText.length} chars`)}` };
    } catch {
      return { ok: false, label: 'stdout starts with { but is not valid JSON' };
    }
  }
  return { ok: true, label: `${green('plain text')} ${dim(`${text.length} chars`)}` };
}

/** Is the generated block present, and does it still match what we'd render? */
function checkBlock(ctx, adapter, cwd) {
  const spec = adapter.contextFile;
  const file = path.isAbsolute(spec.file) ? spec.file : path.join(cwd, spec.file);
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* absent */
  }

  const present = Boolean(text && text.includes(START) && text.includes(END));
  const seed = ctx.seed();
  const shouldExist = Boolean(seed);

  if (!present) {
    return shouldExist
      ? { present: false, status: 'warn', hint: `No generated block in ${spec.file}. \`note-tree sync\` writes it.` }
      : { present: false, status: 'pass' };
  }

  const body = text.slice(text.indexOf(START), text.indexOf(END) + END.length);
  const count = (text.match(new RegExp(escapeRe(START), 'g')) || []).length;
  if (count > 1) {
    return { present: true, status: 'warn', hint: `${spec.file} has ${count} generated blocks. \`note-tree sync\` collapses them.` };
  }
  // Compare on the first note title rather than the whole seed: the block is
  // rendered with project-scope only, so a byte comparison would false-alarm.
  const first = ctx.entries('project').filter((n) => !n.archived)[0];
  const drifted = first && !body.includes(first.title.slice(0, 40));
  return drifted
    ? { present: true, status: 'warn', hint: `The block in ${spec.file} looks stale. \`note-tree sync\` refreshes it.` }
    : { present: true, status: 'pass' };
}

/** Is a command resolvable on PATH? Uses the shell's own resolver, not a guess. */
function which(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : null));
  });
}

const mark = (status) => (status === 'pass' ? green(SYM.ok) : status === 'warn' ? yellow(SYM.warn) : red(SYM.err));
const pad20 = (s) => String(s) + ' '.repeat(Math.max(0, 22 - String(s).length));
/** The AGENTS.md adapter's name lists a dozen tools; the column has room for one. */
const trim = (s, max) => (String(s).length > max ? String(s).slice(0, max - 1) + '…' : String(s));
const strip = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
