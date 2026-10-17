import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ok, report, REPO, SRC, CLI } from './lib/harness.mjs';

const ROOT = REPO;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mcp-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
const HOME = path.join(tmp, 'store');


// --- start the server exactly as an agent would ---
const t0 = process.hrtime.bigint();
const srv = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs'), '--agent', 'claude', '--cwd', proj], {
  env: { ...process.env, NOTE_TREE_HOME: HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
srv.stderr.on('data', (d) => { stderr += d; });

const pending = new Map();
let buf = '';
srv.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});

let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000);
});
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0' },
});
const readyMs = Number(process.hrtime.bigint() - t0) / 1e6;
ok('initialize responds', !!init.result, JSON.stringify(init).slice(0, 200));
ok('protocol version echoed', init.result.protocolVersion === '2025-06-18', init.result.protocolVersion);
ok('serverInfo', init.result.serverInfo.name === 'note-tree');
ok('declares tools capability', !!init.result.capabilities.tools);
console.log(`  handshake ready in ${readyMs.toFixed(0)} ms`);

const oddVersion = await rpc('initialize', { protocolVersion: 'banana', capabilities: {} });
ok('unknown protocol -> our default', oddVersion.result.protocolVersion === '2025-06-18', oddVersion.result.protocolVersion);

notify('notifications/initialized');

const list = await rpc('tools/list');
ok('tools/list', Array.isArray(list.result.tools) && list.result.tools.length === 5, String(list.result.tools?.length));
ok('all tools have schemas', list.result.tools.every((t) => t.inputSchema?.type === 'object' && t.description));
const schemaChars = JSON.stringify(list.result.tools).length;
console.log(`  tool schemas: ${schemaChars} chars ≈ ${Math.ceil(schemaChars / 4)} tokens per session`);

const call = (name, args) => rpc('tools/call', { name, arguments: args });

// write
let r = await call('note_write', {
  title: 'API uses cursor pagination, not offset',
  body: 'The list endpoints return an opaque `next` cursor. Offset params are silently ignored, which is why page 2 looked identical to page 1.',
  kind: 'gotcha',
  tags: ['api', 'pagination'],
});
ok('note_write saves', /^Saved \w+ \(created, project\)/.test(r.result.content[0].text), r.result.content[0].text);
const id = r.result.content[0].text.match(/Saved (\w+)/)[1];

// duplicate protection
r = await call('note_write', {
  title: 'API uses cursor pagination not offset',
  body: 'List endpoints return an opaque next cursor; offset params are silently ignored so page 2 looked like page 1.',
  kind: 'gotcha',
});
ok('duplicate is refused with guidance', /similar to an existing note/.test(r.result.content[0].text), r.result.content[0].text);
ok('duplicate names the existing id', r.result.content[0].text.includes(id));

r = await call('note_write', { title: 'API uses cursor pagination not offset', body: 'Different enough on purpose.', kind: 'gotcha', force: true });
ok('force overrides dedupe', /created/.test(r.result.content[0].text));

// secret redaction through the tool surface
r = await call('note_write', {
  title: 'Staging credentials live in the vault',
  body: 'Do not inline them: ANTHROPIC_API_KEY=sk-ant-api03-QQQQwwwwEEEErrrrTTTTyyyyUUUUiiii1234',
  kind: 'convention',
});
ok('redaction warns through MCP', /redacted possible secrets/.test(r.result.content[0].text), r.result.content[0].text);

// read
r = await call('note_read', { ids: [id] });
ok('note_read returns body', r.result.content[0].text.includes('opaque `next` cursor'), r.result.content[0].text.slice(0, 80));
ok('note_read shows metadata', r.result.content[0].text.includes('gotcha'));

r = await call('note_read', { ids: ['nope00'] });
ok('note_read missing id -> isError', r.result.isError === true);

// search
r = await call('note_search', { query: 'pagination' });
ok('note_search finds it', r.result.content[0].text.includes(id), r.result.content[0].text.slice(0, 120));
r = await call('note_search', { query: 'kind:convention' });
ok('note_search filters', r.result.content[0].text.includes('vault'));
r = await call('note_search', { query: 'nothingmatchesthis' });
ok('note_search empty is friendly', /No notes match/.test(r.result.content[0].text));

// manage
r = await call('note_manage', { action: 'pin', id });
ok('pin works', /^pin: /.test(r.result.content[0].text), r.result.content[0].text);
r = await call('note_manage', { action: 'promote', id });
ok('promote moves to global', /global/.test(r.result.content[0].text), r.result.content[0].text);
r = await call('note_manage', { action: 'archive', id });
ok('archive works', /^archive: /.test(r.result.content[0].text));
r = await call('note_manage', { action: 'bogus', id });
ok('unknown action -> isError', r.result.isError === true);
r = await call('note_manage', { action: 'pin' });
ok('missing id -> isError', r.result.isError === true);

// seed
r = await call('note_seed', {});
ok('note_seed returns the block', r.result.content[0].text.includes('<note-tree-memory>'), r.result.content[0].text.slice(0, 80));

// A `/clear` starts a new session under the same server process; notes must follow it.
{
  const sessions = path.join(HOME, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const state = (sid, ageMs) => {
    const file = path.join(sessions, `${sid}.json`);
    fs.writeFileSync(file, JSON.stringify({ sid, cwd: proj }));
    fs.utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  };
  const indexed = (title) => {
    const projects = path.join(HOME, 'projects');
    for (const slug of fs.readdirSync(projects)) {
      const found = JSON.parse(fs.readFileSync(path.join(projects, slug, 'index.json'), 'utf8')).notes.find((n) => n.title === title);
      if (found) return found;
    }
    return null;
  };
  state('sess-before-clear', 1000);
  await call('note_write', { title: 'Written before the clear', body: 'x', kind: 'todo', force: true });
  state('sess-after-clear', 0);
  await call('note_write', { title: 'Written after the clear', body: 'x', kind: 'todo', force: true });
  ok('mcp: notes follow the session across a /clear', indexed('Written before the clear')?.session === 'sess-before-clear' && indexed('Written after the clear')?.session === 'sess-after-clear',
    `${indexed('Written before the clear')?.session} / ${indexed('Written after the clear')?.session}`);

  // `supersedes` retires the note it replaces instead of leaving both live.
  const oldNote = indexed('Written before the clear');
  r = await call('note_write', { title: 'The corrected fact replaces the old one', body: 'y', kind: 'decision', supersedes: oldNote.id });
  ok('mcp: supersedes archives the old note', indexed('Written before the clear')?.archived === true, r.result.content[0].text);

  // ...but never across scopes: a project note retiring a global one would rewrite
  // every other project's memory from inside this one.
  const globalIndexed = (title) => JSON.parse(fs.readFileSync(path.join(HOME, 'global', 'index.json'), 'utf8')).notes.find((n) => n.title === title);
  await call('note_write', { title: 'A global rule other projects rely on', body: 'z', kind: 'convention', scope: 'global', force: true });
  const rule = globalIndexed('A global rule other projects rely on');
  r = await call('note_write', { title: 'A project note that tries to replace it', body: 'w', kind: 'decision', supersedes: rule.id, force: true });
  ok('mcp: supersedes leaves a global note alone and says why',
    globalIndexed('A global rule other projects rely on')?.archived !== true && /other scope/.test(r.result.content[0].text),
    `${globalIndexed('A global rule other projects rely on')?.archived} / ${r.result.content[0].text}`);
}

// protocol robustness
r = await call('does_not_exist', {});
ok('unknown tool -> JSON-RPC error', r.error?.code === -32602, JSON.stringify(r));
const bad = await rpc('no/such/method', {});
ok('unknown method -> -32601', bad.error?.code === -32601);
ok('ping', (await rpc('ping')).result !== undefined);
ok('resources/list is empty, not an error', Array.isArray((await rpc('resources/list')).result.resources));

// malformed line must not kill the server
srv.stdin.write('{ not json at all\n');
ok('survives malformed input', (await rpc('ping')).result !== undefined);

ok('nothing on stderr', stderr === '', stderr.slice(0, 300));

srv.stdin.end();
await new Promise((r) => srv.on('exit', r));
ok('exits cleanly when stdin closes', srv.exitCode === 0, String(srv.exitCode));

fs.rmSync(tmp, { recursive: true, force: true });
report();
