import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ok, report, REPO, SRC, CLI } from './lib/harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-smoke-'));
process.env.NOTE_TREE_HOME = tmp;

const { loadConfig, PRESETS } = await import(`${SRC}/config.mjs`);
const { projectSlug } = await import(`${SRC}/paths.mjs`);
const { openStore } = await import(`${SRC}/store/index.mjs`);
const { redact, isDeniedPath } = await import(`${SRC}/redact.mjs`);
const { similarity } = await import(`${SRC}/dedupe.mjs`);
const { serializeNote, deserializeNote } = await import(`${SRC}/note.mjs`);
const journal = await import(`${SRC}/journal.mjs`);


const slug = projectSlug(REPO);
console.log('slug:', slug, '\nroot:', tmp, '\n');

for (const format of ['markdown', 'jsonl', 'json']) {
  console.log(`--- ${format} ---`);
  const root = path.join(tmp, format);
  const cfg = loadConfig({ root, slug });
  cfg.storage.format = format;
  const store = openStore(cfg);
  store.ensure();

  const r1 = store.write(
    { title: 'Seed injection is ranked and hard-capped', body: 'Claude Code caps hook output at 10,000 characters. The seed renderer trims by rank until it fits.', kind: 'decision', tags: ['Tokens', 'hooks', 'tokens'] },
    { project: slug, agent: 'claude', session: 'sess1' },
  );
  ok(`${format}: created`, r1.status === 'created', JSON.stringify(r1.warnings));
  ok(`${format}: tags normalized+deduped`, JSON.stringify(r1.note.tags) === '["tokens","hooks"]', JSON.stringify(r1.note.tags));
  ok(`${format}: desc auto-derived`, r1.note.desc.length > 10);

  const got = store.get(r1.note.id);
  ok(`${format}: round-trip body`, got && got.body === r1.note.body);
  ok(`${format}: round-trip title`, got && got.title === r1.note.title);

  const dup = store.write({ title: 'Seed injection is ranked and hard capped!', body: 'Claude Code caps hook output at 10000 chars; the seed renderer trims by rank until it fits.', kind: 'decision' }, {});
  ok(`${format}: duplicate detected`, dup.status === 'duplicate', dup.status);

  const forced = store.write({ title: 'Totally different subject about database pooling', body: 'Use pgbouncer in transaction mode for the API.', kind: 'gotcha', scope: 'global' }, { agent: 'codex' });
  ok(`${format}: global create`, forced.status === 'created' && forced.note.scope === 'global');
  ok(`${format}: global has no project`, forced.note.project === null, String(forced.note.project));

  const upd = store.write({ id: r1.note.id, title: 'Seed injection is ranked, hard-capped and trimmed' }, {});
  ok(`${format}: update keeps id`, upd.status === 'updated' && upd.note.id === r1.note.id, upd.status);
  ok(`${format}: update keeps created`, upd.note.created === r1.note.created);
  ok(`${format}: update kept body`, upd.note.body === r1.note.body);
  ok(`${format}: no orphan after retitle`, store.list({ scope: 'project' }).length === 1, String(store.list({ scope: 'project' }).length));

  store.markRead([r1.note.id]);
  ok(`${format}: reads incremented`, store.get(r1.note.id).reads === 1, String(store.get(r1.note.id).reads));

  store.pin(r1.note.id);
  ok(`${format}: pinned`, store.get(r1.note.id).pinned === true);
  store.archive(r1.note.id);
  ok(`${format}: archived hidden from list`, store.list({ scope: 'project' }).length === 0);
  ok(`${format}: archived visible with flag`, store.list({ scope: 'project', includeArchived: true }).length === 1);
  store.restore(r1.note.id);

  ok(`${format}: project note carries its origin`, store.get(r1.note.id).origin === slug, String(store.get(r1.note.id).origin));
  const promoted = store.promote(r1.note.id);
  ok(`${format}: promote -> global`, promoted.scope === 'global');
  // A global note drops `project` but keeps `origin` — the branch it hangs on in
  // the global tree — so promotion never forgets which project taught it.
  ok(`${format}: promote nulls project, keeps origin`, promoted.project === null && promoted.origin === slug, JSON.stringify({ project: promoted.project, origin: promoted.origin }));
  ok(`${format}: gone from project`, store.list({ scope: 'project', includeArchived: true }).length === 0);
  ok(`${format}: global count 2`, store.list({ scope: 'global' }).length === 2, String(store.list({ scope: 'global' }).length));

  const demoted = store.demote(promoted.id);
  ok(`${format}: demote -> project`, demoted.scope === 'project' && demoted.project === slug);

  ok(`${format}: removed`, store.remove(demoted.id) === true);
  ok(`${format}: stats`, store.stats().total === 1, JSON.stringify(store.stats()));

  const ev = journal.readAll(cfg.paths.journal);
  ok(`${format}: journal wrote events`, ev.length >= 8, String(ev.length));
  ok(`${format}: journal tail`, journal.tail(cfg.paths.journal, 3).length === 3);
  const s = journal.since(cfg.paths.journal, 0);
  ok(`${format}: journal since cursor`, s.events.length === ev.length && s.cursor > 0);
}

console.log('\n--- unit ---');
// frontmatter edge cases
const tricky = {
  v: 1, id: 'ab12cd', title: 'Title: with colon, comma & "quotes"', desc: 'null', kind: 'gotcha',
  tags: ['a-b', 'c/d'], scope: 'project', project: 'p', agent: 'claude', session: 's',
  created: '2026-08-12T00:00:00.000Z', updated: '2026-08-12T00:00:00.000Z',
  reads: 3, pinned: true, archived: false, supersedes: null, links: ['b7c1x2'],
  body: '# Head\n\nSome body --- with dashes\nand a line.',
};
const rt = deserializeNote(serializeNote(tricky));
ok('frontmatter: title survives', rt.title === tricky.title, rt.title);
ok('frontmatter: desc "null" stays a string', rt.desc === 'null', JSON.stringify(rt.desc));
ok('frontmatter: tags array', JSON.stringify(rt.tags) === '["a-b","c/d"]', JSON.stringify(rt.tags));
ok('frontmatter: booleans', rt.pinned === true && rt.archived === false);
ok('frontmatter: numbers', rt.reads === 3);
ok('frontmatter: links', JSON.stringify(rt.links) === '["b7c1x2"]');
ok('frontmatter: body with --- intact', rt.body === tricky.body, JSON.stringify(rt.body));
ok('frontmatter: no-frontmatter file imports', deserializeNote('just some text here that is long enough').body.startsWith('just some'));

// redaction
const r = redact(`api_key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"\nDATABASE_URL=postgres://user:hunter2pass@db/x\nAKIAIOSFODNN7EXAMPLE\nnormal prose about the key to success`);
ok('redact: anthropic key gone', !r.text.includes('sk-ant-api03-AbCdEf'), r.text);
ok('redact: db password gone', !r.text.includes('hunter2pass'));
ok('redact: aws id gone', !r.text.includes('AKIAIOSFODNN7EXAMPLE'));
ok('redact: prose untouched', r.text.includes('normal prose about the key to success'));
const r2 = redact('password = "changeme"\nAPI_KEY=<your-key-here>');
ok('redact: placeholders untouched', r2.hits.length === 0, JSON.stringify(r2));

// Found by dogfooding: a note explaining CI config was gutted by its own
// redactor. A variable reference is a template, never a secret.
const r3 = redact('//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\ntoken=$GITHUB_TOKEN\nAPI_KEY=%USERPROFILE%');
ok('redact: ${VAR} kept', r3.text.includes('${NODE_AUTH_TOKEN}'), JSON.stringify(r3));
ok('redact: $VAR kept', r3.text.includes('$GITHUB_TOKEN'));
ok('redact: %VAR% kept', r3.text.includes('%USERPROFILE%'));
ok('redact: no false positives at all', r3.hits.length === 0, JSON.stringify(r3.hits));
// ...and the real thing still goes.
const r4 = redact('auth_token=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123');
ok('redact: real token still redacted', !r4.text.includes('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123'), r4.text);

ok('glob: .env matched', isDeniedPath('src/.env.local', ['**/.env*']));
ok('glob: bare .env matched', isDeniedPath('.env', ['**/.env*']));
ok('glob: secrets dir matched', isDeniedPath('a/b/secrets/k.txt', ['**/secrets/**']));
ok('glob: pem matched', isDeniedPath('C:\\x\\y\\key.pem', ['**/*.pem']));
ok('glob: normal file not matched', !isDeniedPath('src/index.mjs', ['**/.env*', '**/secrets/**', '**/*.pem']));

ok('similarity: identical', similarity('the cache is warm', 'cache is warm') === 1);
ok('similarity: unrelated low', similarity('database pooling', 'tree rendering svg') < 0.3);

// config layering
const cfgMax = loadConfig({ root: path.join(tmp, 'cfgtest'), slug });
ok('config: default medium', cfgMax.budget.projectNotes === PRESETS.medium.projectNotes);
fs.mkdirSync(path.join(tmp, 'cfgtest'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'cfgtest', 'config.json'), JSON.stringify({ verbosity: 'maximum', budget: { projectNotes: 5 } }));
const cfg2 = loadConfig({ root: path.join(tmp, 'cfgtest'), slug });
ok('config: preset applied', cfg2.budget.globalNotes === PRESETS.maximum.globalNotes, String(cfg2.budget.globalNotes));
ok('config: explicit override wins', cfg2.budget.projectNotes === 5, String(cfg2.budget.projectNotes));
ok('config: seed clamped', cfg2.budget.maxSeedChars <= 9500);
fs.writeFileSync(path.join(tmp, 'cfgtest', 'config.json'), '{ this is not json');
ok('config: corrupt config falls back', loadConfig({ root: path.join(tmp, 'cfgtest'), slug }).verbosity === 'medium');

fs.rmSync(tmp, { recursive: true, force: true });
report();
