/**
 * Import/migration: the readers in-process, then the real CLI end-to-end.
 *
 * HOME/USERPROFILE are redirected before any note-tree module is imported —
 * the source registry resolves ~/.claude-mem and ~/.claude at import time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ok, report, fixtureSqlite, REPO, SRC, CLI } from './lib/harness.mjs';

const { DatabaseSync } = await fixtureSqlite(import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-import-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'orchard-api');
const memHome = path.join(home, '.claude-mem');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(memHome, { recursive: true });
fs.mkdirSync(proj, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.NOTE_TREE_HOME = path.join(home, '.note-tree');
process.env.FORCE_COLOR = '0';


/* ------------------------------------------------------------ fixtures -- */

const db = new DatabaseSync(path.join(memHome, 'index.db'));
db.exec(`
  CREATE TABLE memories (id INTEGER PRIMARY KEY, title TEXT, content TEXT, entity_type TEXT,
                         project TEXT, created_at INTEGER, metadata TEXT);
  CREATE TABLE observations (id INTEGER PRIMARY KEY, role TEXT, content TEXT, tool_use_id TEXT, ts INTEGER);
  CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
  CREATE TABLE chunk_vectors (id INTEGER PRIMARY KEY, embedding BLOB);
`);
const mem = db.prepare('INSERT INTO memories (title, content, entity_type, project, created_at, metadata) VALUES (?,?,?,?,?,?)');
const MEMS = [
  ['Pagination is cursor-based', 'The public API uses cursor pagination, not offset. Passing ?page= is silently ignored and you get page one forever.', 'gotcha'],
  ['Auth tokens live 15 minutes', 'Refresh before every long job. The client does not refresh mid-request.', 'convention'],
  ['We chose Postgres over Mongo', 'Decided in March: the reporting queries are relational and the ops team already runs Postgres.', 'decision'],
  ['Render pipeline shape', 'Gateway terminates TLS, worker pool renders, supervisor restarts dead workers.', 'architecture'],
  ['Prefers small PRs', 'Reviews stall past about 400 changed lines.', 'preference'],
];
for (let i = 0; i < MEMS.length; i++) {
  mem.run(MEMS[i][0], MEMS[i][1], MEMS[i][2], 'orchard-api', 1_750_000_000 + i * 86_400, JSON.stringify({ tags: ['api', 'orchard'] }));
}
mem.run('Huge one', 'x'.repeat(50_000), 'reference', 'orchard-api', 1_750_500_000, null);
mem.run('Too short', 'nope', 'reference', 'orchard-api', 1_750_600_000, null);
const obs = db.prepare('INSERT INTO observations (role, content, tool_use_id, ts) VALUES (?,?,?,?)');
for (let i = 0; i < 5; i++) obs.run('assistant', `I ran the test suite and it passed on attempt ${i}. Nothing else of note here.`, `toolu_${i}`, 1_750_000_000);
db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?,?)').run('0001_init', '2026-01-01');
db.close();

fs.writeFileSync(
  path.join(memHome, 'archive.jsonl'),
  [
    JSON.stringify({ summary: 'The staging deploy needs the VPN; without it the healthcheck times out after 30s.', timestamp: 1_751_000_000_000, tags: 'deploy,staging' }),
    JSON.stringify({ summary: 'Feature flags are read once at boot, so toggling one needs a restart of every worker.', timestamp: 1_751_100_000_000 }),
    '{ not json at all',
    JSON.stringify({ role: 'user', content: 'can you run the tests again for me please and then report back', tool_use_id: 'toolu_x' }),
  ].join('\n'),
);
fs.writeFileSync(path.join(memHome, 'settings.json'), JSON.stringify({ port: 37700, verbose: true }));

const MEMORY_MD = `# Project Memory

<!-- note-tree:start -->
Ignore me: this is note-tree's own generated block.
<!-- note-tree:end -->

## Conventions
- Always run \`npm test\` before committing; the pre-commit hook is advisory only.
- Never edit files under \`generated/\` — they come from the protobuf build.

## Gotchas
- The staging API returns 200 with an error body when the token is expired, which breaks retries.
- Windows paths in the config must use forward slashes or the loader silently ignores them.

## Architecture
The service is split into three processes. The gateway owns TLS and rate limiting, the
worker pool does the rendering, and a supervisor restarts workers that stop heartbeating.
Everything talks over a unix socket, which is why the deployment is single-host for now
and why moving to Kubernetes would not be a small change. This paragraph is long on
purpose so that it crosses the prose threshold and imports as one section note.

## Contents
- ignore me
`;
fs.writeFileSync(path.join(home, '.claude', 'MEMORY.md'), MEMORY_MD);
fs.writeFileSync(
  path.join(proj, 'CLAUDE.md'),
  '# orchard-api\n\n## Build\n- Run `make dev` for the watch loop, never `npm start` directly.\n- Integration tests need docker compose up first.\n',
);

/* -------------------------------------------------------------- readers -- */

const { collect, detectSources, sniff, defaultScope } = await import(`file:///${REPO}/src/import/index.mjs`);

const detected = detectSources(proj).map((d) => d.id).sort();
ok('detects every available source', detected.join(',') === 'claude-md,claude-mem,memory-md', detected.join(','));
ok('sniffs a markdown file', sniff('/x/MEMORY.md') === 'memory-md', sniff('/x/MEMORY.md'));
ok('sniffs CLAUDE.md apart', sniff('/x/CLAUDE.md') === 'claude-md');
ok('sniffs a db as claude-mem by path', sniff('/x/.claude-mem/index.db') === 'claude-mem');
ok('sniffs a bare export as json', sniff('/x/dump.jsonl') === 'json');
ok('home files default to global', defaultScope(path.join(home, '.claude', 'MEMORY.md'), proj) === 'global');
ok('project files default to project', defaultScope(path.join(proj, 'CLAUDE.md'), proj) === 'project');

const cm = collect({ source: 'claude-mem', cwd: proj, project: 'orchard-api', maxBody: 1800 });
ok('claude-mem: notes found', cm.notes.length === 8, String(cm.notes.length));
ok('claude-mem: scope is global (store lives in ~)', cm.scope === 'global', cm.scope);
ok('claude-mem: reads both the db and the jsonl', ['index.db','archive.jsonl'].every((n) => cm.files.some((f) => path.basename(f.file) === n)), cm.files.map((f) => path.basename(f.file)).join(','));
ok('claude-mem: noise tables ignored', !cm.files.some((f) => (f.tables || []).some((t) => /migration|vector/.test(t.name))));
ok('claude-mem: transcript turns skipped', cm.reasons.some(([r, n]) => /transcript/.test(r) && n === 6), JSON.stringify(cm.reasons));
ok('claude-mem: short bodies skipped', cm.reasons.some(([r]) => /no usable body/.test(r)));
ok('claude-mem: bad jsonl line warned about', cm.warnings.some((w) => /not valid JSON/.test(w)), JSON.stringify(cm.warnings));

const cursor = cm.notes.find((n) => /cursor/i.test(n.title));
ok('claude-mem: title mapped', Boolean(cursor));
ok('claude-mem: declared kind wins', cursor?.kind === 'gotcha', cursor?.kind);
ok('claude-mem: epoch seconds → ISO', cursor?.created === '2025-06-15T15:06:40.000Z', String(cursor?.created));
ok('claude-mem: tags from nested JSON metadata', cursor?.tags.includes('orchard'), JSON.stringify(cursor?.tags));
ok('claude-mem: provenance recorded', cursor?.agent === 'import:claude-mem', String(cursor?.agent));
ok('claude-mem: global notes carry no project', cm.notes.every((n) => n.project === null));
const huge = cm.notes.find((n) => n.title === 'Huge one');
ok('claude-mem: long body trimmed to maxBody', huge && huge.body.length < 1900 && /truncated on import/.test(huge.body), String(huge?.body.length));
const jsonlNote = cm.notes.find((n) => /VPN/.test(n.body));
ok('jsonl: title synthesised from the body', jsonlNote?.title.startsWith('The staging deploy needs the VPN'), String(jsonlNote?.title));
ok('jsonl: epoch millis → ISO', jsonlNote?.created === '2025-06-27T04:53:20.000Z', String(jsonlNote?.created));
ok('jsonl: comma tags split', jsonlNote?.tags.includes('staging'), JSON.stringify(jsonlNote?.tags));

const md = collect({ source: 'memory-md', cwd: proj });
ok('memory-md: one note per bullet, prose section kept', md.notes.length === 5, String(md.notes.length));
ok('memory-md: our own generated block is not re-imported', !md.notes.some((n) => /Ignore me/.test(n.body)));
ok('memory-md: boilerplate heading skipped', !md.notes.some((n) => /ignore me/i.test(n.title)));
ok('memory-md: heading drives kind', md.notes.filter((n) => n.kind === 'gotcha').length === 2, JSON.stringify(md.notes.map((n) => n.kind)));
ok('memory-md: heading becomes tags', md.notes[0].tags.includes('conventions'), JSON.stringify(md.notes[0].tags));
ok('memory-md: prose section survives whole', md.notes.some((n) => n.kind === 'architecture' && n.body.length > 300));
ok('memory-md: inline code stripped from the title', md.notes[0].title === 'Always run npm test before committing', md.notes[0].title);
ok('memory-md: file mtime dates the notes', /^20\d\d-/.test(String(md.notes[0].created)), String(md.notes[0].created));

const bySection = collect({ source: 'memory-md', cwd: proj, bySection: true });
ok('--by-section collapses bullets into headings', bySection.notes.length === 3, String(bySection.notes.length));

const cmd = collect({ source: 'claude-md', cwd: proj, project: 'orchard-api' });
ok('claude-md: found in the project', cmd.notes.length === 2, String(cmd.notes.length));
ok('claude-md: scoped to the project', cmd.scope === 'project' && cmd.notes.every((n) => n.project === 'orchard-api'));

let threw = '';
try {
  collect({ source: 'json', cwd: proj });
} catch (e) {
  threw = e.message;
}
ok('json without --file explains itself', /--file/.test(threw), threw);

/* ------------------------------------------------------------------ CLI -- */

const env = { ...process.env, HOME: home, USERPROFILE: home, NOTE_TREE_HOME: path.join(home, '.note-tree'), FORCE_COLOR: '0' };
const nt = (...args) => spawnSync(process.execPath, [`${REPO}/bin/note-tree.mjs`, ...args], { cwd: proj, env, encoding: 'utf8' });

const dry = nt('import', '--from', 'memory-md', '--dry-run');
ok('CLI dry-run exits 0', dry.status === 0, `${dry.status} ${dry.stderr}`);
ok('CLI dry-run says it wrote nothing', /Nothing was written/.test(dry.stdout), dry.stdout.slice(0, 400));
ok('CLI dry-run shows the kind breakdown', /gotcha\s+2/.test(dry.stdout), dry.stdout.slice(0, 600));
ok('CLI dry-run really wrote nothing', !fs.existsSync(path.join(home, '.note-tree', 'global', 'notes')));

const run = nt('import', '--from', 'memory-md');
ok('CLI import exits 0', run.status === 0, `${run.status} ${run.stderr}`);
ok('CLI import reports 5 notes', /imported 5 notes into the global tree/.test(run.stdout), run.stdout.slice(0, 500));

const listed = JSON.parse(nt('list', '--global', '--json').stdout || '{}');
const rows = Array.isArray(listed) ? listed : listed.notes || [];
ok('notes are on disk and indexed', rows.length === 5, String(rows.length));
ok('provenance survives the round trip', rows.every((n) => n.agent === 'import:memory-md'), JSON.stringify(rows[0]));
ok('branch per day of history', new Set(rows.map((n) => n.session)).size === 1 && /^import-20/.test(rows[0].session), String(rows[0].session));

const again = nt('import', '--from', 'memory-md');
ok('re-import is near-idempotent', /already looked like notes you have/.test(again.stdout), again.stdout.slice(0, 500));
ok('re-import imported nothing new', JSON.parse(nt('list', '--global', '--json').stdout).length === 5);

const ambiguous = nt('import');
ok('ambiguous auto-detect asks rather than guesses', ambiguous.status === 1 && /More than one source/.test(ambiguous.stdout), ambiguous.stdout.slice(0, 300));

const cmRun = nt('import', '--from', 'claude-mem', '--limit', '3');
ok('CLI honours --limit', /imported 3 notes/.test(cmRun.stdout), cmRun.stdout.slice(0, 400));

const projRun = nt('import', '--from', 'claude-md');
ok('project-scoped import lands in the project tree', /imported 2 notes into the project tree/.test(projRun.stdout), projRun.stdout.slice(0, 400));

const missing = nt('import', '--from', 'nope');
ok('unknown source is rejected', missing.status === 1 && /unknown source/.test(missing.stdout + missing.stderr));

const jsonOut = nt('import', '--from', 'claude-mem', '--dry-run', '--json');
const parsed = JSON.parse(jsonOut.stdout);
ok('--json is machine-readable', parsed.dryRun === true && parsed.wouldImport === 8, jsonOut.stdout.slice(0, 200));

fs.rmSync(root, { recursive: true, force: true });
report();
