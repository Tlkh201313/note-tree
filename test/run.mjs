/**
 * The whole test suite: `node test/run.mjs`.
 *
 * Each suite runs in its own process — several of them redirect HOME before
 * importing note-tree, and one spawns a server — so isolation is a process
 * boundary rather than a convention. Output is quiet unless something fails.
 *
 *   node test/run.mjs                 everything
 *   node test/run.mjs core recall     only suites whose name matches
 *   node test/run.mjs --verbose       stream every assertion as it passes
 *   node test/run.mjs --list          just say what exists
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const filters = argv.filter((a) => !a.startsWith('-'));

const SUITES = [
  ['repo', 'zero deps, manifests, the command table matches its modules'],
  ['core', 'config, note schema, all three storage drivers, redaction, journal'],
  ['recall', 'index, ranking, search, seed budget and injection safety'],
  ['adapters', 'the agent registry, wiring, and the generated context block'],
  ['autorefresh', 'context files stay fresh as notes change'],
  ['hooks', 'SessionStart / Stop / SessionEnd, including fail-open faults'],
  ['mcp', 'the stdio server, driven over real JSON-RPC'],
  ['server', 'the live tree server: routes, SSE, and its loopback defences'],
  ['sqlite', 'the hand-rolled SQLite reader (fixtures need Node 22+)'],
  ['import', 'migration from claude-mem, MEMORY.md, CLAUDE.md and JSON'],
];

if (argv.includes('--list')) {
  for (const [name, blurb] of SUITES) console.log(`  ${name.padEnd(13)} ${blurb}`);
  process.exit(0);
}

const chosen = SUITES.filter(([n]) => !filters.length || filters.some((f) => n.includes(f)));
if (!chosen.length) {
  console.error(`No suite matches ${filters.join(', ')}. Try --list.`);
  process.exit(1);
}

/* --------------------------------------------------------------------------
 * Tests must never touch the real home directory. Every suite is supposed to
 * redirect HOME and NOTE_TREE_HOME into a temp dir; this notices the day one
 * of them forgets, instead of the user noticing.
 * ------------------------------------------------------------------------ */
const home = os.homedir();
const WATCHED = [
  path.join(home, '.note-tree'),
  path.join(home, '.claude', 'settings.json'),
  path.join(home, '.claude.json'),
  path.join(home, '.codex', 'config.toml'),
  path.join(home, '.codex', 'hooks.json'),
  path.join(home, '.config', 'opencode', 'opencode.json'),
  path.join(home, '.gemini', 'settings.json'),
  path.join(home, '.cursor', 'mcp.json'),
  path.join(DIR, '..', 'AGENTS.md'),
  path.join(DIR, '..', 'CLAUDE.md'),
];
const snapshot = () =>
  WATCHED.map((p) => {
    try {
      const s = fs.statSync(p);
      return `${p}:${s.mtimeMs}:${s.size}`;
    } catch {
      return `${p}:absent`;
    }
  });
const before = snapshot();

const run = (name) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(DIR, `${name}.mjs`)], {
      env: { ...process.env, NT_TEST_VERBOSE: VERBOSE ? '1' : '', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (VERBOSE) process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; if (VERBOSE) process.stderr.write(d); });
    child.on('exit', (code) => {
      const tally = out.match(/^(\d+) passed, (\d+) failed$/m);
      resolve({
        name,
        ms: Date.now() - started,
        out,
        code,
        skipped: /^skipped — /m.test(out),
        pass: tally ? Number(tally[1]) : 0,
        fail: tally ? Number(tally[2]) : 0,
      });
    });
  });

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', YEL = '\x1b[33m', OFF = '\x1b[0m';
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (colour ? code + s + OFF : s);

console.log(`note-tree — ${chosen.length} suites on ${process.version} (${process.platform})\n`);

const results = [];
for (const [name] of chosen) {
  const r = await run(name);
  results.push(r);

  const broken = r.fail > 0 || (r.code !== 0 && !r.skipped) || (!r.skipped && r.pass === 0);
  const label = r.name.padEnd(13);
  const time = c(DIM, `${(r.ms / 1000).toFixed(1)}s`);
  if (r.skipped) console.log(`${c(YEL, '–')} ${label} ${c(YEL, 'skipped')} ${time}`);
  else if (broken) console.log(`${c(RED, '✗')} ${label} ${c(RED, `${r.fail} failed`)}, ${r.pass} passed  ${time}`);
  else console.log(`${c(GREEN, '✓')} ${label} ${r.pass} passed  ${time}`);

  if (broken && !VERBOSE) {
    console.log(r.out.split('\n').map((l) => '    ' + l).join('\n'));
  }
}

/* ---------------------------------------------------------------- totals -- */
const passed = results.reduce((n, r) => n + r.pass, 0);
const failed = results.reduce((n, r) => n + r.fail, 0);
const crashed = results.filter((r) => !r.skipped && (r.code !== 0 || r.pass === 0) && r.fail === 0);
const skipped = results.filter((r) => r.skipped);
const seconds = (results.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(1);

console.log('');
console.log(`${passed} assertions passed, ${failed} failed${skipped.length ? `, ${skipped.length} suite(s) skipped` : ''} in ${seconds}s`);
for (const r of skipped) console.log(c(DIM, `  skipped ${r.name}: ${r.out.match(/^skipped — (.*)$/m)?.[1] || ''}`));

const touched = snapshot().filter((line, i) => line !== before[i]);
if (touched.length) {
  console.log(c(RED, '\nTests modified files outside their sandbox:'));
  for (const t of touched) console.log('  ' + t.split(':')[0]);
}

const bad = failed > 0 || crashed.length > 0 || touched.length > 0;
if (crashed.length) console.log(c(RED, `\n${crashed.map((r) => r.name).join(', ')} exited without reporting.`));
console.log(bad ? c(RED, '\nFAILED') : c(GREEN, '\nAll green.'));
process.exit(bad ? 1 : 0);
