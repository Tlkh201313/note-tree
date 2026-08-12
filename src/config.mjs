/**
 * Configuration: defaults, verbosity presets, and the global/project merge.
 *
 * Loading NEVER throws. A corrupt or unreadable config falls back to defaults,
 * because a broken config file must not be able to break someone's session.
 */

import fs from 'node:fs';
import { paths } from './paths.mjs';

/**
 * Claude Code caps all hook output at 10,000 characters; output beyond that is
 * spilled to a file and replaced with a preview, which would defeat the point.
 * We stay comfortably under it no matter how the budget is configured.
 */
export const SEED_HARD_CAP = 9500;

export const KINDS = [
  'decision',
  'convention',
  'gotcha',
  'architecture',
  'preference',
  'reference',
  'todo',
];

export const DEFAULTS = {
  version: 1,
  storage: {
    format: 'markdown', // markdown | jsonl | json
    root: null, // null => ~/.note-tree (or $NOTE_TREE_HOME)
    journal: true,
  },
  verbosity: 'medium', // minimal | medium | maximum — the master dial
  budget: {
    projectNotes: 16,
    globalNotes: 5,
    maxSeedChars: 3500,
    noteBodyWords: 150,
  },
  capture: {
    stopNudge: true,
    // 'user'  — one line to you, costs the model nothing (default)
    // 'agent' — asks the model to save the note itself; opt-in, since it
    //           extends a turn you didn't ask to extend
    nudgeMode: 'user',
    nudgeAfterEdits: 3,
    nudgeCooldownMin: 30,
    autoTagFromPath: true,
    dedupeThreshold: 0.85,
  },
  ranking: {
    pinnedBoost: 1000,
    halfLifeDays: 30,
    readBoost: 2,
    kindWeights: {
      gotcha: 3,
      decision: 2,
      convention: 2,
      preference: 2,
      architecture: 1,
      todo: 1,
      reference: 0,
    },
  },
  agents: {
    enabled: [], // filled in by `note-tree init`
    attribute: true,
  },
  contextFile: {
    // Tier B: agents with no session hook read a generated block instead.
    // `AGENTS.md` is usually committed, so personal/global notes stay out by default.
    includeGlobal: false,
    autoRefresh: true,
  },
  ui: { port: 4747, open: true, theme: 'forest', reducedMotion: 'auto' },
  mcp: { enabled: true },
  hooks: { injectionMode: 'auto', failOpen: true, watchdogMs: 400 },
  privacy: {
    redactSecrets: true,
    telemetry: false,
    denyPathPatterns: ['**/.env*', '**/secrets/**', '**/*.pem'],
  },
};

/** The "how long should the context be" dial, in concrete numbers. */
export const PRESETS = {
  minimal: { projectNotes: 8, globalNotes: 3, maxSeedChars: 1200, noteBodyWords: 60 },
  medium: { projectNotes: 16, globalNotes: 5, maxSeedChars: 3500, noteBodyWords: 150 },
  maximum: { projectNotes: 30, globalNotes: 8, maxSeedChars: 8000, noteBodyWords: 400 },
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Recursive merge; arrays replace rather than concatenate. */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Read JSON, returning `fallback` on any error. Never throws. */
export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Resolve effective config.
 *
 * Layering: DEFAULTS -> global config.json -> project config.json, then the
 * verbosity preset is applied to `budget` — but only for keys the user did not
 * set explicitly, so `verbosity: "maximum"` plus `budget.projectNotes: 5` does
 * what it looks like it does.
 */
export function loadConfig({ root = null, slug = null } = {}) {
  const bootPaths = paths(root);
  let globalRaw = readJsonSafe(bootPaths.config, {}) || {};

  // A config at the default location may point the store somewhere else. Honour
  // that redirect, then re-read the config from wherever we actually landed.
  const p = paths(root, slug, globalRaw?.storage?.root || null);
  if (p.root !== bootPaths.root) {
    globalRaw = readJsonSafe(p.config, null) || globalRaw;
  }
  const projectRaw = slug ? readJsonSafe(p.projectConfig, {}) || {} : {};

  let cfg = deepMerge(DEFAULTS, globalRaw);
  cfg = deepMerge(cfg, projectRaw);

  const preset = PRESETS[cfg.verbosity] || PRESETS.medium;
  const explicitBudget = { ...(globalRaw.budget || {}), ...(projectRaw.budget || {}) };
  cfg.budget = { ...DEFAULTS.budget, ...preset, ...explicitBudget };

  // Clamp to the hook output ceiling regardless of what anyone configured.
  cfg.budget.maxSeedChars = Math.max(
    200,
    Math.min(cfg.budget.maxSeedChars ?? preset.maxSeedChars, SEED_HARD_CAP),
  );

  // `storage.root` stays exactly as the user wrote it — the *resolved* root
  // lives on `paths`, so saving the config back never bakes in a temporary
  // `NOTE_TREE_HOME` or a one-off `--root`.
  cfg.paths = p;
  cfg.slug = slug;
  return cfg;
}

/** Write the global config, creating the root if needed. Returns the path. */
export function saveGlobalConfig(cfg, { root = null } = {}) {
  const p = paths(root);
  fs.mkdirSync(p.root, { recursive: true });
  const { paths: _p, slug: _s, ...clean } = cfg;
  fs.writeFileSync(p.config, JSON.stringify(clean, null, 2) + '\n');
  return p.config;
}

/** Write a project-scoped override file. Returns the path. */
export function saveProjectConfig(partial, { root = null, slug }) {
  const p = paths(root, slug);
  fs.mkdirSync(p.projectDir, { recursive: true });
  const existing = readJsonSafe(p.projectConfig, {}) || {};
  fs.writeFileSync(p.projectConfig, JSON.stringify(deepMerge(existing, partial), null, 2) + '\n');
  return p.projectConfig;
}

/** Dotted-path get, e.g. `budget.projectNotes`. */
export function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Dotted-path set on a shallow-cloned object tree. Returns a new object. */
export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const out = { ...obj };
  let node = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    node[k] = isPlainObject(node[k]) ? { ...node[k] } : {};
    node = node[k];
  }
  node[keys[keys.length - 1]] = value;
  return out;
}

/** Coerce a CLI string into the type the existing default implies. */
export function coerceValue(raw, current) {
  if (typeof current === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`expected a number, got "${raw}"`);
    return n;
  }
  if (typeof current === 'boolean') {
    if (/^(true|yes|on|1)$/i.test(raw)) return true;
    if (/^(false|no|off|0)$/i.test(raw)) return false;
    throw new Error(`expected a boolean, got "${raw}"`);
  }
  if (Array.isArray(current)) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}
