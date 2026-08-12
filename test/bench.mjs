/**
 * The benchmark behind every number in the README.
 *
 *   node test/bench.mjs                 human-readable + the markdown table
 *   node test/bench.mjs --notes 5000    a bigger tree
 *   node test/bench.mjs --json          machine-readable
 *
 * Method, stated so it can be argued with:
 *   - Latency is measured the way a session pays it: a real `node
 *     hooks/session-start.mjs` process, spawned with a real SessionStart
 *     payload on stdin, timed from spawn to exit. That includes Node's own
 *     start-up, which is most of it — so bare `node -e 0` is measured the same
 *     way and reported alongside. note-tree's own cost is the difference.
 *   - Median of N runs after warm-ups, with p95, because a cold page cache on
 *     the first run is not what a user experiences all day.
 *   - Tokens are estimated at 4 characters per token. That is an estimate, not
 *     a tokeniser, and it is applied identically to every row — so the ratios
 *     hold even where the absolute numbers drift a little.
 *
 * It also fails the build: SessionStart must stay under 150 ms at 1,000 notes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const JSON_OUT = args.includes('--json');
const NOTES = flag('notes', 1000);
const RUNS = flag('runs', 21);
const BUDGET_MS = flag('budget', 150);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-bench-'));
const proj = path.join(tmp, 'project');
fs.mkdirSync(proj, { recursive: true });
const HOME = path.join(tmp, 'store');
process.env.NOTE_TREE_HOME = HOME;
const env = { ...process.env, NOTE_TREE_HOME: HOME, FORCE_COLOR: '0' };

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const ms = (n) => `${n.toFixed(1)} ms`;
const tokens = (chars) => Math.ceil(chars / 4);

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    min: s[0],
    max: s[s.length - 1],
  };
};

/** Wall-clock of a whole process, which is what a session actually waits for. */
function timeSpawn(argv, { input = '', runs = RUNS, warmup = 3 } = {}) {
  const times = [];
  for (let i = 0; i < runs + warmup; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(process.execPath, argv, { input, encoding: 'utf8', env });
    const took = Number(process.hrtime.bigint() - t) / 1e6;
    if (i >= warmup) times.push(took);
    if (r.status !== 0) throw new Error(`${argv.join(' ')} exited ${r.status}: ${r.stderr}`);
  }
  return stats(times);
}

/* ------------------------------------------------------------- the tree -- */

const SRC = pathToFileURL(path.join(REPO, 'src')).href;
const { openContext } = await import(`${SRC}/context.mjs`);

say(`note-tree bench — ${process.version} on ${process.platform}, ${NOTES} notes\n`);

const KINDS = ['decision', 'convention', 'gotcha', 'architecture', 'preference', 'reference', 'todo'];
const TOPICS = ['pagination', 'session hooks', 'token budgets', 'index rebuilds', 'svg layout', 'redaction', 'the adapter registry', 'atomic writes'];

const ctx = openContext({ cwd: proj, agent: 'bench', session: 'bench-0' });
ctx.store.ensure();

const buildStart = process.hrtime.bigint();
for (let i = 0; i < NOTES; i++) {
  ctx.session = `bench-${Math.floor(i / 12)}`; // ~12 notes per session, i.e. per branch
  ctx.write(
    {
      title: `Note ${i}: ${TOPICS[i % TOPICS.length]} behaves differently than it looks`,
      desc: `A one-line summary of finding ${i} that the seed can show instead of the body.`,
      body: `Detail for finding ${i}. It explains why ${TOPICS[i % TOPICS.length]} works the way it does, what breaks when you assume otherwise, and the shape of the fix. Roughly the length of a note someone would actually write after a session.`,
      kind: KINDS[i % KINDS.length],
      tags: [`t${i % 7}`, 'bench'],
      scope: i % 20 === 0 ? 'global' : 'project',
    },
    { force: true },
  );
}
const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
const counts = { project: ctx.entries('project').length, global: ctx.entries('global').length };
say(`built ${counts.project} project + ${counts.global} global notes in ${ms(buildMs)}  (${ms(buildMs / NOTES)} per write, index kept live)`);

const storeBytes = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
};
const onDisk = storeBytes(HOME);

/* ------------------------------------------------------- the hot path ---- */

const payload = JSON.stringify({ session_id: 'bench', cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
const bare = timeSpawn(['-e', '0'], { input: '' });
const hook = timeSpawn([path.join(REPO, 'hooks', 'session-start.mjs'), '--agent', 'claude', '--cwd', proj], { input: payload });
const cli = timeSpawn([path.join(REPO, 'bin', 'note-tree.mjs'), 'seed', '--dry-run', '--cwd', proj], { input: '' , runs: 7 });

say('');
say('session start (what every session pays)');
say(`  bare node -e 0        ${ms(bare.median).padStart(9)}   p95 ${ms(bare.p95)}`);
say(`  note-tree SessionStart${ms(hook.median).padStart(9)}   p95 ${ms(hook.p95)}`);
say(`  note-tree's own cost  ${ms(hook.median - bare.median).padStart(9)}`);
say(`  note-tree seed (CLI)  ${ms(cli.median).padStart(9)}`);

/* --------------------------------------------------------- what it costs -- */

const { PRESETS } = await import(`${SRC}/config.mjs`);
const presets = {};
for (const name of ['minimal', 'medium', 'maximum']) {
  const c = openContext({ cwd: proj, agent: 'bench' });
  Object.assign(c.cfg.budget, PRESETS[name]);
  c.cfg.verbosity = name;
  const seed = c.seed();
  presets[name] = { chars: seed.chars, tokens: tokens(seed.chars), notes: seed.counts.rendered };
}

say('');
say('injected per session');
for (const [name, p] of Object.entries(presets)) {
  say(`  ${name.padEnd(9)} ${String(p.chars).padStart(6)} chars ≈ ${String(p.tokens).padStart(5)} tokens   ${p.notes} notes`);
}

// The comparison that matters: a whole file, loaded whether or not it's relevant.
// 25 KB is the documented cap on Claude Code's MEMORY.md.
const MEMORY_MD_CAP = 25 * 1024;
const ratio = MEMORY_MD_CAP / presets.medium.chars;
say(`  a 25 KB MEMORY.md at its documented cap ≈ ${tokens(MEMORY_MD_CAP)} tokens — ${ratio.toFixed(0)}× the medium seed`);

/* ----------------------------------------------------------------- MCP --- */

const mcpStart = process.hrtime.bigint();
const handshake = spawnSync(
  process.execPath,
  [path.join(REPO, 'mcp', 'server.mjs'), '--agent', 'bench', '--cwd', proj],
  {
    input:
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
    encoding: 'utf8',
    env,
  },
);
const mcpMs = Number(process.hrtime.bigint() - mcpStart) / 1e6;
const toolsLine = handshake.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2);
const toolChars = JSON.stringify(toolsLine.result.tools).length;
say('');
say(`mcp server: ${toolsLine.result.tools.length} tools, ${toolChars} chars of schema ≈ ${tokens(toolChars)} tokens per session, ready in ${ms(mcpMs)}`);
say(`on disk: ${(onDisk / 1024).toFixed(0)} KB for ${NOTES} notes (${(onDisk / NOTES).toFixed(0)} bytes each), index read at session start: ${(fs.statSync(path.join(HOME, 'projects', ctx.slug, 'index.json')).size / 1024).toFixed(1)} KB`);

/* -------------------------------------------------------------- search --- */

const searchTimes = [];
for (let i = 0; i < 20; i++) {
  const t = process.hrtime.bigint();
  ctx.search(TOPICS[i % TOPICS.length]);
  searchTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
}
const search = stats(searchTimes);
const reindexStart = process.hrtime.bigint();
ctx.reindex();
const reindexMs = Number(process.hrtime.bigint() - reindexStart) / 1e6;
say(`search across ${NOTES} notes: ${ms(search.median)} · full reindex from disk: ${ms(reindexMs)}`);

/* ---------------------------------------------------------- the table ---- */

const table = [
  '| measurement | note-tree |',
  '| --- | --- |',
  `| SessionStart, end to end | **${hook.median.toFixed(0)} ms** (p95 ${hook.p95.toFixed(0)} ms) |`,
  `| …of which is Node itself | ${bare.median.toFixed(0)} ms — note-tree adds **${(hook.median - bare.median).toFixed(0)} ms** |`,
  `| Injected per session | **~${presets.medium.tokens} tokens** (${presets.medium.notes} notes, medium) |`,
  `| Resident processes | **none** |`,
  `| API calls to save a note | **zero** |`,
  `| MCP tool schemas | ${toolsLine.result.tools.length} tools, ~${tokens(toolChars)} tokens |`,
  `| Search across ${NOTES} notes | ${search.median.toFixed(1)} ms |`,
  `| Store size | ${(onDisk / 1024).toFixed(0)} KB for ${NOTES} notes |`,
  `| Dependencies | **0** |`,
];

say('');
say('README table:');
say('');
say(table.join('\n'));

const result = {
  version: process.version,
  platform: `${process.platform} ${process.arch}`,
  notes: NOTES,
  runs: RUNS,
  counts,
  sessionStart: { median: hook.median, p95: hook.p95, bareNode: bare.median, ownCost: hook.median - bare.median },
  cliSeed: cli.median,
  presets,
  memoryMdCapTokens: tokens(MEMORY_MD_CAP),
  mcp: { tools: toolsLine.result.tools.length, schemaChars: toolChars, schemaTokens: tokens(toolChars), readyMs: mcpMs },
  storeBytes: onDisk,
  writeMsPerNote: buildMs / NOTES,
  searchMs: search.median,
  reindexMs,
  budgetMs: BUDGET_MS,
  table: table.join('\n'),
};

if (JSON_OUT) console.log(JSON.stringify(result, null, 2));

fs.rmSync(tmp, { recursive: true, force: true });

const over = hook.median > BUDGET_MS;
if (over) {
  console.error(`\nFAILED: SessionStart is ${ms(hook.median)} at ${NOTES} notes — the budget is ${BUDGET_MS} ms.`);
  process.exit(1);
}
say(`\nwithin budget: ${ms(hook.median)} ≤ ${BUDGET_MS} ms at ${NOTES} notes.`);
