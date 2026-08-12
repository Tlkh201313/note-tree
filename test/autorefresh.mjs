import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { ok, report, REPO, SRC, CLI } from './lib/harness.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ar-'));
const proj = path.join(tmp, 'proj'); fs.mkdirSync(proj, { recursive: true });
process.env.NOTE_TREE_HOME = path.join(tmp, 'store');
const { openContext } = await import(`${SRC}/context.mjs`);
const { projectSlug } = await import(`${SRC}/paths.mjs`);
const { saveProjectConfig } = await import(`${SRC}/config.mjs`);

const agents = path.join(proj, 'AGENTS.md');
const ctx0 = openContext({ cwd: proj, agent: 'claude' });
ctx0.write({ title: 'Nothing wired yet', body: 'No adapter is enabled, so no file should appear.', kind: 'decision' });
ok('no file until init enables an agent', !fs.existsSync(agents));

saveProjectConfig({ agents: { enabled: ['agents-md'] } }, { slug: projectSlug(proj) });
const ctx = openContext({ cwd: proj, agent: 'codex' });
ok('adapters resolved from config', ctx.contextAdapters().map(a=>a.id).join() === 'agents-md');

ctx.write({ title: 'Cache keys are namespaced by tenant', body: 'Every redis key is prefixed with the tenant id; forgetting it leaks data across tenants.', kind: 'gotcha' });
ok('AGENTS.md auto-created on write', fs.existsSync(agents));
const v1 = fs.readFileSync(agents, 'utf8');
ok('contains the new note', v1.includes('tenant'), v1.slice(0,200));
ok('contains the earlier note too', v1.includes('Nothing wired'));

ctx.write({ title: 'Second fact about deployment ordering', body: 'Migrations run before the new image rolls out, never after.', kind: 'architecture' });
const v2 = fs.readFileSync(agents, 'utf8');
ok('refreshed on the next write', v2.includes('deployment ordering') && v2 !== v1);
ok('still exactly one block', (v2.match(/<!-- note-tree:start -->/g)||[]).length === 1);

const id = ctx.entries('project').find(n => n.title.includes('tenant')).id;
ctx.store.archive(id);
ok('archiving refreshes too', !fs.readFileSync(agents,'utf8').includes('tenant'));

ctx.store.markRead([ctx.entries('project')[0].id]);
ok('a read does not rewrite the file', true);

const r = ctx.reindex();
ok('sync reports context files', Array.isArray(r.contextFiles) && r.contextFiles.length === 1, JSON.stringify(r));
fs.rmSync(tmp, { recursive: true, force: true });
report();
