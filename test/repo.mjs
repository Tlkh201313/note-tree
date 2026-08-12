/**
 * The invariants that live in the repo rather than in the code: zero
 * dependencies, a command table that matches the modules behind it, manifests
 * that point at files which exist, and one version number everywhere.
 *
 * These are the things that break silently — a renamed export, a `files` entry
 * dropped from package.json — and only ever surface for someone who installed
 * from npm.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ok, report, tmpdir, REPO } from './lib/harness.mjs';

// Importing the command modules must not resolve anything against the real
// home directory, so redirect before the first import.
const sandbox = tmpdir('nt-repo-');
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.NOTE_TREE_HOME = path.join(sandbox, '.note-tree');

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(REPO, rel));
const pkg = JSON.parse(read('package.json'));

/* ------------------------------------------------------------ zero deps -- */

ok('no runtime dependencies', Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies));
ok('no dev dependencies either', Object.keys(pkg.devDependencies || {}).length === 0, JSON.stringify(pkg.devDependencies));
ok('no optional or peer dependencies', !pkg.optionalDependencies && !pkg.peerDependencies);
ok('nothing to install before running', !exists('node_modules') && !exists('package-lock.json'));

/** Every .mjs we ship, so the import audit can't miss a directory. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}
const sources = ['bin', 'src', 'hooks', 'mcp'].flatMap((d) => walk(d));
ok('found the shipped sources', sources.length > 25, String(sources.length));

const foreign = [];
for (const rel of sources) {
  const text = read(rel);
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+'([^']+)'/g)) {
    const spec = m[1];
    if (!spec.startsWith('node:') && !spec.startsWith('.')) foreign.push(`${rel} → ${spec}`);
  }
  for (const m of text.matchAll(/\bawait import\('([^']+)'\)/g)) {
    const spec = m[1];
    if (!spec.startsWith('node:') && !spec.startsWith('.')) foreign.push(`${rel} → ${spec}`);
  }
}
ok('every import is node: or relative', foreign.length === 0, foreign.join(', '));

// node:sqlite only exists from Node 22 — the shipped reader must never use it.
const usesNodeSqlite = sources.filter((rel) => /'node:sqlite'/.test(read(rel)));
ok('the shipped code never uses node:sqlite', usesNodeSqlite.length === 0, usesNodeSqlite.join(', '));

/* ------------------------------------------------------------ packaging -- */

for (const entry of pkg.files) ok(`files: ${entry} exists`, exists(entry));
ok('the bin entry exists', exists(pkg.bin['note-tree']));
ok('the bin entry has a shebang', read(pkg.bin['note-tree']).startsWith('#!/usr/bin/env node'));
ok('engines allows Node 18', pkg.engines.node === '>=18.0.0', pkg.engines.node);
ok('package is ESM', pkg.type === 'module');
ok('license is declared', pkg.license === 'MIT' && exists('LICENSE'));

const { VERSION } = await import(pathToFileURL(path.join(REPO, 'src/cli/index.mjs')).href);
ok('CLI version matches package.json', VERSION === pkg.version, `${VERSION} vs ${pkg.version}`);
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
ok('plugin version matches package.json', plugin.version === pkg.version, plugin.version);
ok('changelog documents this version', new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\]`, 'm').test(read('CHANGELOG.md')));

/* ------------------------------------------------------------ manifests -- */

ok('plugin declares the hooks file', plugin.hooks === './hooks/hooks.json' && exists('hooks/hooks.json'));
ok('plugin registers the MCP server', plugin.mcpServers['note-tree'].command === 'node');
const mcpArg = plugin.mcpServers['note-tree'].args[0];
ok('MCP server path is plugin-relative', mcpArg.startsWith('${CLAUDE_PLUGIN_ROOT}/'), mcpArg);
ok('MCP server file exists', exists(mcpArg.replace('${CLAUDE_PLUGIN_ROOT}/', '')));

const hooksJson = JSON.parse(read('hooks/hooks.json'));
const hookEvents = Object.keys(hooksJson.hooks);
ok('hooks cover the three events', ['SessionStart', 'Stop', 'SessionEnd'].every((e) => hookEvents.includes(e)), hookEvents.join());
for (const [event, groups] of Object.entries(hooksJson.hooks)) {
  for (const g of groups) {
    for (const h of g.hooks) {
      const file = h.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)?.[1];
      ok(`${event} hook points at a real file`, Boolean(file) && exists(file), h.command);
      ok(`${event} hook declares a timeout`, typeof h.timeout === 'number' && h.timeout <= 10, String(h.timeout));
    }
  }
}

const market = JSON.parse(read('.claude-plugin/marketplace.json'));
ok('marketplace lists the plugin', market.plugins.some((p) => p.name === 'note-tree'));

/* --------------------------------------------------- skill and commands -- */

const skill = read('skills/note-tree/SKILL.md');
ok('SKILL.md has frontmatter', skill.startsWith('---\n'));
ok('SKILL.md declares a name', /\nname: note-tree\n/.test(skill));
ok('SKILL.md description says when to use it', /\ndescription: .*[Uu]se when/.test(skill));
for (const file of fs.readdirSync(path.join(REPO, 'commands'))) {
  const body = read(`commands/${file}`);
  ok(`commands/${file} has a description`, /^---\n(?:.*\n)*?description: \S/.test(body));
}

/* ---------------------------------------------- the command table is true - */

const { COMMANDS, GROUPS } = await import(pathToFileURL(path.join(REPO, 'src/cli/registry.mjs')).href);
ok('every command is documented', COMMANDS.every((c) => c.summary && c.usage && c.group), 'missing summary/usage/group');
ok('every group is declared', COMMANDS.every((c) => GROUPS.includes(c.group)), COMMANDS.filter((c) => !GROUPS.includes(c.group)).map((c) => c.name).join());

const names = new Set();
for (const c of COMMANDS) {
  for (const n of [c.name, ...(c.aliases || [])]) {
    ok(`"${n}" is not a duplicate`, !names.has(n));
    names.add(n);
  }
}

const loaded = new Map();
for (const c of COMMANDS) {
  const rel = path.join('src/cli', c.module);
  if (!loaded.has(rel)) {
    ok(`${c.module} exists`, exists(rel));
    loaded.set(rel, await import(pathToFileURL(path.join(REPO, rel)).href));
  }
  const mod = loaded.get(rel);
  ok(`${c.name} → ${c.fn}() is exported`, typeof mod[c.fn] === 'function', Object.keys(mod).join());
  ok(`${c.name} usage starts with the command`, c.usage.startsWith(`note-tree ${c.name}`), c.usage);
}
ok('every promised command exists', ['init', 'sync', 'help', 'config', 'add', 'list', 'search', 'tree', 'export', 'import', 'doctor', 'demo', 'adapters', 'seed', 'migrate', 'uninstall', 'prune', 'promote'].every((n) => names.has(n)), [...names].join());

/* ---------------------------------------------------- docs stay honest --- */

const adapters = await import(pathToFileURL(path.join(REPO, 'src/agents/registry.mjs')).href);
const security = read('SECURITY.md');
ok('SECURITY.md documents the trust boundary', /Notes are data/.test(security));
ok('CONTRIBUTING explains adding an adapter', /Adding support for another agent CLI/.test(read('CONTRIBUTING.md')));
for (const a of adapters.ADAPTERS) {
  ok(`${a.id} declares its confidence`, a.confidence === 'verified' || a.confidence === 'community', String(a.confidence));
}
if (exists('README.md')) {
  const readme = read('README.md');
  for (const a of adapters.ADAPTERS) {
    ok(`README mentions ${a.name}`, readme.includes(a.name));
  }
  const experimental = adapters.ADAPTERS.filter((a) => a.confidence === 'community');
  for (const a of experimental) {
    // Anything we haven't confirmed against first-party docs has to say so on
    // the page people decide from, not three clicks away.
    const row = readme.split('\n').find((l) => l.includes(a.name) && l.startsWith('|'));
    ok(`README marks ${a.name} experimental`, Boolean(row) && /experimental/i.test(row), row || 'no table row');
  }
}

/* ------------------------------------------------ nothing escapes /tmp --- */

ok('the real home was never used', !fs.existsSync(path.join(os.homedir(), '.note-tree', 'test-marker')));

report();
