import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ok, report, REPO, SRC, CLI } from './lib/harness.mjs';

const ROOT = REPO;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-hooks-'));
const proj = path.join(tmp, 'demo-project');
fs.mkdirSync(proj, { recursive: true });
const HOME = path.join(tmp, 'store');
const env = { ...process.env, NOTE_TREE_HOME: HOME };


function hook(file, payload, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', file), ...args], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...env, ...extraEnv },
  });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
}

// seed the store via the library
const { openContext } = await import(`${SRC}/context.mjs`);
process.env.NOTE_TREE_HOME = HOME;
const ctx = openContext({ cwd: proj, agent: 'claude', session: 'seed-session' });
ctx.store.ensure();
for (let i = 0; i < 25; i++) {
  ctx.write({
    title: `Durable fact ${i} about the build pipeline stage ${i}`,
    body: `Detail for fact ${i} explaining why the pipeline behaves this way and what breaks otherwise.`,
    kind: ['decision', 'gotcha', 'convention'][i % 3],
    scope: i % 6 === 0 ? 'global' : 'project',
  }, { force: true });
}

console.log('--- SessionStart ---');
const payload = { session_id: 'abc123', transcript_path: path.join(tmp, 'transcript.jsonl'), cwd: proj, hook_event_name: 'SessionStart', source: 'startup' };

const claude = hook('session-start.mjs', payload, ['--agent', 'claude']);
ok('claude: exit 0', claude.code === 0, String(claude.code));
let parsed = null;
try { parsed = JSON.parse(claude.out); } catch { /* */ }
ok('claude: valid JSON envelope', !!parsed, claude.out.slice(0, 120));
ok('claude: hookEventName', parsed?.hookSpecificOutput?.hookEventName === 'SessionStart');
ok('claude: additionalContext present', typeof parsed?.hookSpecificOutput?.additionalContext === 'string' && parsed.hookSpecificOutput.additionalContext.includes('<note-tree-memory>'));
ok('claude: no stderr', claude.err === '', claude.err);
console.log(`  seed: ${parsed?.hookSpecificOutput?.additionalContext?.length} chars`);

const codex = hook('session-start.mjs', payload, ['--agent', 'codex']);
const cp = JSON.parse(codex.out);
ok('codex: continue true', cp.continue === true);
ok('codex: additionalContext', cp.hookSpecificOutput.additionalContext.includes('<note-tree-memory>'));
ok('cross-agent: same memory', cp.hookSpecificOutput.additionalContext === parsed.hookSpecificOutput.additionalContext);

const oc = hook('session-start.mjs', payload, ['--agent', 'opencode']);
ok('opencode: raw text', oc.out.startsWith('<note-tree-memory>'), oc.out.slice(0, 60));

const textMode = hook('session-start.mjs', payload, ['--agent', 'claude', '--mode', 'text']);
ok('text mode: raw, not JSON', textMode.out.startsWith('<note-tree-memory>'));

// empty store => zero tokens
const emptyEnv = { NOTE_TREE_HOME: path.join(tmp, 'empty-store') };
const empty = hook('session-start.mjs', { ...payload, cwd: proj }, ['--agent', 'claude'], emptyEnv);
ok('empty store: prints nothing', empty.out === '', empty.out);
ok('empty store: exit 0', empty.code === 0);

// session state recorded
const stateFile = path.join(HOME, 'sessions', 'abc123.json');
ok('session state written', fs.existsSync(stateFile));

console.log('\n--- fault injection (must always fail open) ---');
const faults = [
  ['corrupt project index', () => {
    const idxFile = fs.readdirSync(path.join(HOME, 'projects'))[0];
    fs.writeFileSync(path.join(HOME, 'projects', idxFile, 'index.json'), '{ broken json ');
  }],
  ['corrupt global config', () => fs.writeFileSync(path.join(HOME, 'config.json'), 'not json at all')],
  ['garbage on stdin', null],
  ['no stdin payload', null],
];
for (const [name, mutate] of faults) {
  if (mutate) mutate();
  const r = name === 'garbage on stdin'
    ? spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs'), '--agent', 'claude'], { input: 'not json <<<', encoding: 'utf8', env })
    : name === 'no stdin payload'
      ? spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs'), '--agent', 'claude'], { input: '', encoding: 'utf8', env })
      : spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs'), '--agent', 'claude'], { input: JSON.stringify(payload), encoding: 'utf8', env });
  ok(`${name}: exit 0`, r.status === 0, String(r.status));
  ok(`${name}: stdout is empty or valid JSON`, r.stdout.trim() === '' || (() => { try { JSON.parse(r.stdout); return true; } catch { return false; } })(), r.stdout.slice(0, 100));
}
// repair the store for the remaining tests
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ version: 1 }, null, 2));
ctx.reindex();

console.log('\n--- Stop nudge ---');
const transcript = path.join(tmp, 'transcript.jsonl');
fs.writeFileSync(transcript, '');
const stopPayload = { session_id: 'stop1', transcript_path: transcript, cwd: proj, hook_event_name: 'Stop', stop_hook_active: false };

let r1 = hook('stop-nudge.mjs', stopPayload, ['--agent', 'claude']);
ok('no edits: silent', r1.out === '', r1.out);

fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }) + '\n');
r1 = hook('stop-nudge.mjs', stopPayload, ['--agent', 'claude']);
ok('1 edit: still silent', r1.out === '', r1.out);

for (let i = 0; i < 4; i++) fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }) + '\n');
r1 = hook('stop-nudge.mjs', stopPayload, ['--agent', 'claude']);
const nudge = r1.out ? JSON.parse(r1.out) : null;
ok('5 edits: nudged', !!(nudge?.decision || nudge?.systemMessage), r1.out);
// Default is agent mode: the model is asked to save the note itself, which is
// what actually fills the memory up rather than leaving the tools unused.
ok('nudge asks the model to save, by default', nudge?.decision === 'block' && /note_write/.test(nudge.reason || ''), r1.out);

r1 = hook('stop-nudge.mjs', stopPayload, ['--agent', 'claude']);
ok('cooldown suppresses repeat', r1.out === '', r1.out);

r1 = hook('stop-nudge.mjs', { ...stopPayload, stop_hook_active: true }, ['--agent', 'claude']);
ok('stop_hook_active: never loops', r1.out === '', r1.out);

// user mode — the opt-out: one line to the person instead, costing the model
// nothing and never extending the turn.
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ capture: { nudgeMode: 'user', nudgeCooldownMin: 0 } }));
r1 = hook('stop-nudge.mjs', { ...stopPayload, session_id: 'stop2' }, ['--agent', 'claude']);
const userNudge = r1.out ? JSON.parse(r1.out) : null;
ok('user mode speaks to the person, not the model', !!userNudge?.systemMessage && !userNudge?.decision, r1.out);

r1 = hook('stop-nudge.mjs', { ...stopPayload, session_id: 'stop3' }, ['--agent', 'codex']);
ok('non-claude agent stays silent', r1.out === '', r1.out);

// saved a note this session => no nudge
const ctx2 = openContext({ cwd: proj, agent: 'claude', session: 'stop4' });
ctx2.write({ title: 'Something learned in stop4 session', body: 'x'.repeat(50), kind: 'gotcha' }, { force: true });
r1 = hook('stop-nudge.mjs', { ...stopPayload, session_id: 'stop4' }, ['--agent', 'claude']);
ok('note saved this session: silent', r1.out === '', r1.out);

fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ capture: { stopNudge: false } }));
r1 = hook('stop-nudge.mjs', { ...stopPayload, session_id: 'stop5' }, ['--agent', 'claude']);
ok('stopNudge:false disables it', r1.out === '', r1.out);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ version: 1 }));

console.log('\n--- SessionEnd ---');
const end = hook('session-end.mjs', { session_id: 'abc123', cwd: proj, hook_event_name: 'SessionEnd', reason: 'clear' }, ['--agent', 'claude']);
ok('session-end: exit 0 silent', end.code === 0 && end.out === '', end.out);
ok('session-end: state cleaned up', !fs.existsSync(stateFile));
const journal = fs.readFileSync(path.join(HOME, 'journal.jsonl'), 'utf8');
ok('session-end: journal line', journal.includes('"ev":"session-end"'));

console.log('\n--- cold-start latency (what every session pays) ---');
const runs = [];
for (let i = 0; i < 12; i++) {
  const t = process.hrtime.bigint();
  spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs'), '--agent', 'claude'], { input: JSON.stringify(payload), encoding: 'utf8', env });
  runs.push(Number(process.hrtime.bigint() - t) / 1e6);
}
runs.sort((a, b) => a - b);
const median = runs[Math.floor(runs.length / 2)];
const baseline = [];
for (let i = 0; i < 8; i++) {
  const t = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  baseline.push(Number(process.hrtime.bigint() - t) / 1e6);
}
baseline.sort((a, b) => a - b);
const base = baseline[Math.floor(baseline.length / 2)];
console.log(`  bare node:        ${base.toFixed(1)} ms`);
console.log(`  note-tree hook:   ${median.toFixed(1)} ms  (p95 ${runs[Math.floor(runs.length * 0.95)].toFixed(1)} ms)`);
console.log(`  note-tree's cost: ${(median - base).toFixed(1)} ms over bare node`);
ok('hot path under 150 ms', median < 150, `${median.toFixed(1)} ms`);

fs.rmSync(tmp, { recursive: true, force: true });
report();
