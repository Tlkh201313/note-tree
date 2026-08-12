/**
 * `note-tree config` — the settings surface.
 *
 * Two rules make this safe to use without reading docs: we only ever write keys
 * that already exist in DEFAULTS (a typo is an error, not a silently ignored
 * setting), and the value is coerced to the type the default implies.
 */

import { projectSlug } from '../../paths.mjs';
import {
  DEFAULTS, PRESETS, loadConfig, saveGlobalConfig, saveProjectConfig,
  getPath, setPath, coerceValue, readJsonSafe,
} from '../../config.mjs';
import { say, ok, fail, dim, bold, cyan, green, gray, yellow, json, table, wrap } from '../out.mjs';

const ACTIONS = ['get', 'set', 'list', 'unset', 'path', 'presets'];

export async function config(args) {
  const [action = 'list', key, ...rest] = args.positionals;
  if (!ACTIONS.includes(action)) {
    throw new Error(`unknown action "${action}" — try: ${ACTIONS.join(', ')}`);
  }

  const slug = projectSlug(args.cwd);
  const cfg = loadConfig({ root: args.root, slug });
  const scope = args.flags.project ? 'project' : 'global';

  if (action === 'presets') return showPresets(args, cfg);
  if (action === 'path') return showPaths(args, cfg, slug);
  if (action === 'list') return listAll(args, cfg);

  if (!key) throw new Error(`\`config ${action}\` needs a key, e.g. budget.projectNotes`);

  const current = getPath(DEFAULTS, key);
  if (current === undefined) {
    const near = nearestKey(key);
    throw new Error(`no setting called "${key}"${near ? ` — did you mean ${near}?` : ''}`);
  }

  if (action === 'get') {
    const value = getPath(cfg, key);
    if (args.json) return json({ key, value, default: current }), 0;
    say(`${bold(key)} ${dim('=')} ${format(value)}${
      JSON.stringify(value) === JSON.stringify(current) ? dim('  (default)') : ''
    }`);
    return 0;
  }

  const file = scope === 'project' ? cfg.paths.projectConfig : cfg.paths.config;
  const existing = readJsonSafe(file, {}) || {};

  if (action === 'unset') {
    const next = removePath(existing, key);
    write(next, scope, args, slug);
    say(ok(`${bold(key)} reset to ${format(getPath(DEFAULTS, key))} ${dim(`(${scope})`)}`));
    return 0;
  }

  // set
  const raw = rest.join(' ');
  if (!raw) throw new Error(`\`config set ${key}\` needs a value`);
  let value;
  try {
    value = coerceValue(raw, current);
  } catch (error) {
    throw new Error(`${key}: ${error.message}`);
  }

  const invalid = validate(key, value);
  if (invalid) throw new Error(`${key}: ${invalid}`);

  write(setPath(existing, key, value), scope, args, slug);
  say(ok(`${bold(key)} ${dim('=')} ${format(value)} ${dim(`(${scope})`)}`));
  if (key === 'verbosity') {
    const p = PRESETS[value];
    if (p) say(dim(`  ${p.projectNotes} project + ${p.globalNotes} global notes, up to ${p.maxSeedChars} chars per session`));
  }
  return 0;
}

/* ------------------------------------------------------------------ */

function write(next, scope, args, slug) {
  if (scope === 'project') saveProjectConfig(next, { root: args.root, slug });
  else saveGlobalConfig(next, { root: args.root });
}

function listAll(args, cfg) {
  if (args.json) {
    const { paths, slug, ...clean } = cfg;
    return json(clean), 0;
  }

  const rows = [];
  walk(DEFAULTS, '', (key, def) => {
    const value = getPath(cfg, key);
    const changed = JSON.stringify(value) !== JSON.stringify(def);
    rows.push([changed ? green(key) : key, format(value), changed ? dim('changed') : '']);
  });

  say(bold('Settings') + dim(`   ${cfg.paths.config}`));
  say('');
  say(table(rows, { columns: [{ header: 'key' }, { header: 'value', flex: true }, { header: '' }] }));
  say('');
  say(dim(`note-tree config set <key> <value>   ·   add --project to override here only`));
  return 0;
}

function showPresets(args, cfg) {
  if (args.json) return json(PRESETS), 0;
  const rows = Object.entries(PRESETS).map(([name, p]) => [
    name === cfg.verbosity ? green(`${name} ←`) : name,
    String(p.projectNotes),
    String(p.globalNotes),
    String(p.maxSeedChars),
    String(p.noteBodyWords),
    dim(`~${Math.round(p.maxSeedChars / 4 / 10) * 10} tok max`),
  ]);
  say(bold('Verbosity presets') + dim('   how much context each session gets'));
  say('');
  say(
    table(rows, {
      columns: [
        { header: 'preset' },
        { header: 'project', align: 'right' },
        { header: 'global', align: 'right' },
        { header: 'chars', align: 'right' },
        { header: 'body words', align: 'right' },
        { header: '' },
      ],
    }),
  );
  say('');
  say(dim('note-tree config set verbosity maximum'));
  return 0;
}

function showPaths(args, cfg, slug) {
  const p = cfg.paths;
  const rows = [
    ['root', p.root],
    ['config', p.config],
    ['journal', p.journal],
    ['global notes', p.globalNotes],
    ['project', p.projectDir || dim('(no project here)')],
    ['project notes', p.projectNotes || dim('—')],
  ];
  if (args.json) return json({ slug, ...Object.fromEntries(rows) }), 0;
  say(bold('Paths') + dim(`   project slug: ${slug}`));
  say('');
  say(table(rows.map(([k, v]) => [dim(k), v]), { columns: [{ header: '' }, { header: '', flex: true }] }));
  return 0;
}

/* ------------------------------------------------------------------ */

function walk(obj, prefix, visit) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) walk(v, key, visit);
    else visit(key, v);
  }
}

function allKeys() {
  const keys = [];
  walk(DEFAULTS, '', (k) => keys.push(k));
  return keys;
}

/** Suggest the key they probably meant — typos are the common case here. */
function nearestKey(key) {
  const target = key.toLowerCase();
  const keys = allKeys();
  const partial = keys.find((k) => k.toLowerCase().endsWith(`.${target}`) || k.toLowerCase() === target);
  if (partial) return bold(partial);

  let best = null;
  let bestScore = Infinity;
  for (const k of keys) {
    const d = editDistance(target, k.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = k;
    }
  }
  return bestScore <= Math.max(2, Math.floor(target.length / 4)) ? bold(best) : null;
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

function format(value) {
  if (value === null || value === undefined) return dim('null');
  if (typeof value === 'boolean') return value ? green('true') : yellow('false');
  if (typeof value === 'number') return cyan(String(value));
  if (Array.isArray(value)) return value.length ? value.join(', ') : dim('(empty)');
  return String(value);
}

/** Guard rails for the settings where a wrong value is quietly harmful. */
function validate(key, value) {
  if (key === 'verbosity' && !PRESETS[value]) return `expected ${Object.keys(PRESETS).join(' | ')}`;
  if (key === 'storage.format' && !['markdown', 'jsonl', 'json'].includes(value)) {
    return 'expected markdown | jsonl | json';
  }
  if (key === 'hooks.injectionMode' && !['auto', 'json', 'text'].includes(value)) {
    return 'expected auto | json | text';
  }
  if (key === 'capture.nudgeMode' && !['user', 'agent'].includes(value)) return 'expected user | agent';
  if (key.startsWith('budget.') && typeof value === 'number' && value < 0) return 'must not be negative';
  if (key === 'ui.port' && (value < 1 || value > 65535)) return 'must be a valid port';
  if (key === 'capture.dedupeThreshold' && (value < 0 || value > 1)) return 'must be between 0 and 1';
  return null;
}

function removePath(obj, dotted) {
  const keys = dotted.split('.');
  const out = { ...obj };
  let node = out;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] === undefined) return out;
    node[keys[i]] = { ...node[keys[i]] };
    node = node[keys[i]];
  }
  delete node[keys.at(-1)];
  return out;
}
