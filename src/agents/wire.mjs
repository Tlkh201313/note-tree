/**
 * Writing note-tree into each CLI's own config — idempotently, additively, and
 * reversibly.
 *
 * The rules every writer here obeys, because these files belong to the user and
 * we are a guest in them:
 *
 *   1. **Back up before the first edit.** A copy lands in `~/.note-tree/backups/`.
 *   2. **Never overwrite.** Other MCP servers, other hooks, unrelated keys — all
 *      survive. We add our entry and touch nothing else.
 *   3. **Idempotent.** Wiring twice changes nothing the second time. Our old
 *      entries are removed before the fresh ones go in, so a moved install path
 *      updates rather than duplicates.
 *   4. **Refuse rather than clobber.** If a config exists but doesn't parse, we
 *      report an error and leave it exactly as it was.
 *   5. **Reversible.** `unwire()` removes precisely what we added.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, byId, bestTier, mcpEntry, posix } from './registry.mjs';
import {
  readTextSafe,
  atomicWrite,
  exists,
  removeFile,
  backupFile,
  ensureDir,
} from '../fsutil.mjs';

/** Where note-tree itself is installed — `src/agents/wire.mjs` → package root. */
export const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const SERVER_KEY = 'note-tree';

/** Seconds. SessionStart gets headroom for a cold Node; the others are trivial. */
const HOOK_TIMEOUTS = { SessionStart: 10, Stop: 5, SessionEnd: 5 };

/* ------------------------------------------------------------------ *
 * Identifying our own entries
 * ------------------------------------------------------------------ */

const HOOK_FILES = /(session-start|stop-nudge|session-end)\.mjs/;

/** Precise enough that a user's unrelated path containing "note-tree" is safe. */
function isOurCommand(cmd) {
  const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
  return /note-tree/i.test(s) && HOOK_FILES.test(s);
}

function hookCommand(pluginRoot, file, agentId, nodeBin) {
  return `${nodeBin} "${posix(path.join(pluginRoot, 'hooks', file))}" --agent ${agentId}`;
}

/* ------------------------------------------------------------------ *
 * JSON editing
 * ------------------------------------------------------------------ */

/**
 * Read → mutate → write a JSON config.
 *
 * `mutate` gets the parsed document (an empty object for a new file) and edits
 * it in place. Returns `unchanged` when the serialized result is identical, so
 * repeated `init` runs are genuinely free and never churn backups.
 */
function editJson(file, mutate, { backups, dryRun = false } = {}) {
  const before = readTextSafe(file, null);
  let doc = {};
  if (before !== null && before.trim()) {
    try {
      doc = JSON.parse(before);
    } catch {
      return {
        file,
        status: 'error',
        error: `${path.basename(file)} is not valid JSON — fix or move it, then re-run.`,
      };
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { file, status: 'error', error: `${path.basename(file)} is not a JSON object.` };
    }
  }

  mutate(doc);
  const after = JSON.stringify(doc, null, 2) + '\n';
  if (before !== null && after === before) return { file, status: 'unchanged' };
  if (dryRun) return { file, status: before === null ? 'created' : 'updated', dryRun: true };

  const backup = before === null ? null : backupFile(file, backups);
  ensureDir(path.dirname(file));
  atomicWrite(file, after);
  return { file, status: before === null ? 'created' : 'updated', backup };
}

/* ------------------------------------------------------------------ *
 * TOML — just enough for `[mcp_servers.note-tree]`
 * ------------------------------------------------------------------ */

/**
 * A section upsert, not a TOML parser.
 *
 * Codex's `config.toml` is hand-edited and full of comments a round-trip
 * through a parser would destroy. So we locate our section by its header,
 * replace it up to the next top-level `[`, and leave every other byte alone.
 */
const TOML_HEADER = new RegExp(
  String.raw`^[ \t]*\[\s*mcp_servers\s*\.\s*(?:"note-tree"|'note-tree'|note-tree)\s*\][ \t]*$`,
  'm',
);

function tomlString(s) {
  return JSON.stringify(String(s)); // TOML basic strings accept JSON escaping
}

function renderTomlSection(entry) {
  const lines = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ];
  return lines.join('\n');
}

/** Byte range of our section, header through the line before the next `[`. */
function findTomlSection(text) {
  const m = TOML_HEADER.exec(text);
  if (!m) return null;
  const start = m.index;
  const rest = text.slice(m.index + m[0].length);
  const next = /^\s*\[/m.exec(rest);
  const end = next === null ? text.length : m.index + m[0].length + next.index;
  return { start, end };
}

function editToml(file, section, { backups, dryRun = false, remove = false } = {}) {
  const before = readTextSafe(file, null);
  const existing = before ?? '';
  const found = findTomlSection(existing);

  let after;
  if (remove) {
    if (!found) return { file, status: 'unchanged' };
    after = (existing.slice(0, found.start).replace(/\n+$/, '\n') + existing.slice(found.end)).replace(
      /^\n+/,
      '',
    );
  } else if (found) {
    after = existing.slice(0, found.start) + section + '\n' + existing.slice(found.end);
  } else {
    const sep = !existing || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    after = `${existing}${sep}${section}\n`;
  }

  if (before !== null && after === before) return { file, status: 'unchanged' };
  if (dryRun) return { file, status: before === null ? 'created' : 'updated', dryRun: true };

  const backup = before === null ? null : backupFile(file, backups);
  ensureDir(path.dirname(file));
  atomicWrite(file, after);
  return { file, status: before === null ? 'created' : 'updated', backup };
}

/* ------------------------------------------------------------------ *
 * Hook writers
 * ------------------------------------------------------------------ */

/**
 * Claude Code's `settings.json` shape:
 *   hooks: { SessionStart: [ { matcher?, hooks: [ {type:'command', command, timeout} ] } ] }
 *
 * We strip every entry that is ours first, then add fresh ones. That makes a
 * moved install update in place instead of stacking a second copy.
 */
function claudeHooks(doc, { pluginRoot, agentId, nodeBin, events }) {
  const hooks = (doc.hooks ||= {});
  for (const [event, file] of Object.entries(events)) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = list
      .map((group) => ({
        ...group,
        hooks: (group?.hooks || []).filter((h) => !isOurCommand(h?.command)),
      }))
      .filter((group) => group.hooks.length > 0);

    kept.push({
      hooks: [
        {
          type: 'command',
          command: hookCommand(pluginRoot, file, agentId, nodeBin),
          timeout: HOOK_TIMEOUTS[event] ?? 5,
        },
      ],
    });
    hooks[event] = kept;
  }
}

/**
 * Codex's `hooks.json`.
 *
 * The exact envelope is the least-certain thing in this file — sources disagree
 * on whether hooks live here or inline in `config.toml`. We write the documented
 * location and shape; `note-tree doctor` reports what Codex actually loaded, and
 * Codex still gets memory via AGENTS.md and MCP regardless.
 *
 * Both `startup` and `resume` get their own entry rather than one alternation,
 * so this is correct whether or not matchers accept a pattern.
 */
function codexHooks(doc, { pluginRoot, agentId, nodeBin, events }) {
  const hooks = (doc.hooks ||= {});
  for (const [event, file] of Object.entries(events)) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = list
      .map((group) => ({
        ...group,
        hooks: (group?.hooks || []).filter((h) => !isOurCommand(h?.command)),
      }))
      .filter((group) => group.hooks.length > 0);

    const matchers = event === 'SessionStart' ? ['startup', 'resume'] : [null];
    for (const matcher of matchers) {
      const group = {
        hooks: [
          {
            type: 'command',
            command: hookCommand(pluginRoot, file, agentId, nodeBin),
            timeout: HOOK_TIMEOUTS[event] ?? 5,
          },
        ],
      };
      if (matcher) group.matcher = matcher;
      kept.push(group);
    }
    hooks[event] = kept;
  }
}

function stripHooks(doc) {
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event]
      .map((group) => ({ ...group, hooks: (group?.hooks || []).filter((h) => !isOurCommand(h?.command)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete doc.hooks;
}

/**
 * opencode loads plain JS plugins from its config directory.
 *
 * Marked experimental: the injection point is the least-documented part of
 * opencode's plugin API. Every line is inside a try/catch and the plugin
 * returns a no-op on any surprise, so the worst case is that opencode falls
 * back to AGENTS.md — never a broken session.
 */
function opencodePlugin(pluginRoot) {
  const recallUrl = `file:///${posix(path.join(pluginRoot, 'src', 'recall.mjs'))}`.replace(
    'file:////',
    'file:///',
  );
  return `// Generated by note-tree. Safe to delete — \`note-tree init\` rewrites it.
// Experimental: if opencode's plugin API differs, this quietly does nothing and
// AGENTS.md (Tier B) still carries your memory.

export const NoteTree = async ({ directory } = {}) => {
  let block = null;
  try {
    const { recall } = await import(${JSON.stringify(recallUrl)});
    block = recall({ cwd: directory || process.cwd() })?.seed?.text || null;
  } catch {}

  return {
    'chat.params': async (_input, output) => {
      if (!block || !output) return;
      try {
        const opts = (output.options ||= {});
        if (typeof opts.system === 'string') {
          if (!opts.system.includes(block)) opts.system += '\\n\\n' + block;
        } else if (Array.isArray(opts.system)) {
          if (!opts.system.includes(block)) opts.system.push(block);
        } else {
          opts.system = block;
        }
      } catch {}
    },
  };
};
`;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function resolveFile(spec, cwd) {
  return path.isAbsolute(spec.file) ? spec.file : path.join(cwd, spec.file);
}

/**
 * Copy SKILL.md where the agent looks for skills.
 *
 * A plain copy, not a symlink: symlinks need privileges on Windows, and a
 * dangling one after `npm uninstall` would be worse than a stale file.
 */
function installSkill(spec, pluginRoot, { dryRun } = {}) {
  const src = path.join(pluginRoot, spec.source);
  const dest = path.join(spec.dir, path.basename(spec.source));
  const contents = readTextSafe(src, null);
  if (contents === null) return { file: dest, status: 'error', error: `skill not found at ${src}` };
  if (readTextSafe(dest, null) === contents) return { file: dest, status: 'unchanged' };
  if (dryRun) return { file: dest, status: exists(dest) ? 'updated' : 'created', dryRun: true };
  try {
    ensureDir(spec.dir);
    atomicWrite(dest, contents);
    return { file: dest, status: 'created' };
  } catch (err) {
    return { file: dest, status: 'error', error: err.message };
  }
}

/**
 * Wire one agent to the best tiers it supports.
 *
 * @returns `{ agent, name, tier, actions: [{kind, file, status, ...}] }`
 */
export function wire(agentId, opts = {}) {
  const {
    cwd = process.cwd(),
    pluginRoot = PLUGIN_ROOT,
    backups = null,
    nodeBin = 'node',
    dryRun = false,
    hooks: doHooks = true,
    mcp: doMcp = true,
  } = opts;

  const adapter = byId(agentId);
  if (!adapter) return { agent: agentId, actions: [{ kind: 'agent', status: 'error', error: `Unknown agent "${agentId}"` }] };

  const actions = [];
  const io = { backups, dryRun };

  // --- Tier A: hooks ------------------------------------------------
  if (doHooks && adapter.hook) {
    const spec = adapter.hook;
    const file = resolveFile(spec, cwd);
    const ctx = { pluginRoot, agentId, nodeBin, events: spec.events || {} };

    if (spec.format === 'claude-settings') {
      actions.push({ kind: 'hook', tier: 'A', ...editJson(file, (d) => claudeHooks(d, ctx), io) });
    } else if (spec.format === 'codex-hooks') {
      actions.push({ kind: 'hook', tier: 'A', ...editJson(file, (d) => codexHooks(d, ctx), io) });
    } else if (spec.format === 'opencode-plugin') {
      const contents = opencodePlugin(pluginRoot);
      const before = readTextSafe(file, null);
      if (before === contents) {
        actions.push({ kind: 'hook', tier: 'A', file, status: 'unchanged' });
      } else if (dryRun) {
        actions.push({ kind: 'hook', tier: 'A', file, status: before === null ? 'created' : 'updated', dryRun: true });
      } else {
        const backup = before === null ? null : backupFile(file, backups);
        ensureDir(path.dirname(file));
        atomicWrite(file, contents);
        actions.push({
          kind: 'hook',
          tier: 'A',
          file,
          status: before === null ? 'created' : 'updated',
          backup,
          experimental: true,
        });
      }
    }
  }

  // --- The skill ----------------------------------------------------
  // Not a tier: it carries no memory. It's the instructions that decide
  // whether what does get saved is worth its tokens.
  if (doHooks && adapter.skill) {
    actions.push({ kind: 'skill', ...installSkill(adapter.skill, pluginRoot, io) });
  }

  // --- Tier C: MCP --------------------------------------------------
  if (doMcp && adapter.mcp) {
    const spec = adapter.mcp;
    const file = resolveFile(spec, cwd);
    const entry = mcpEntry(pluginRoot, agentId, { nodeBin });

    if (spec.format === 'toml') {
      actions.push({ kind: 'mcp', tier: 'C', ...editToml(file, renderTomlSection(entry), io) });
    } else {
      actions.push({
        kind: 'mcp',
        tier: 'C',
        ...editJson(
          file,
          (d) => {
            const bag = (d[spec.key] ||= {});
            bag[SERVER_KEY] = entry;
          },
          io,
        ),
      });
    }
  }

  return { agent: adapter.id, name: adapter.name, tier: bestTier(adapter), actions };
}

/** Remove everything `wire()` added for one agent. Tier B is handled separately. */
export function unwire(agentId, opts = {}) {
  const { cwd = process.cwd(), backups = null, dryRun = false } = opts;
  const adapter = byId(agentId);
  if (!adapter) return { agent: agentId, actions: [] };

  const actions = [];
  const io = { backups, dryRun };

  if (adapter.hook) {
    const file = resolveFile(adapter.hook, cwd);
    if (adapter.hook.format === 'opencode-plugin') {
      const had = exists(file);
      if (!dryRun && had) removeFile(file);
      actions.push({ kind: 'hook', file, status: had ? 'removed' : 'absent' });
    } else if (exists(file)) {
      actions.push({ kind: 'hook', ...editJson(file, stripHooks, io) });
    } else {
      actions.push({ kind: 'hook', file, status: 'absent' });
    }
  }

  if (adapter.skill) {
    const file = path.join(adapter.skill.dir, path.basename(adapter.skill.source));
    const had = exists(file);
    if (!dryRun && had) removeFile(file);
    actions.push({ kind: 'skill', file, status: had ? 'removed' : 'absent' });
  }

  if (adapter.mcp) {
    const spec = adapter.mcp;
    const file = resolveFile(spec, cwd);
    if (!exists(file)) {
      actions.push({ kind: 'mcp', file, status: 'absent' });
    } else if (spec.format === 'toml') {
      actions.push({ kind: 'mcp', ...editToml(file, '', { ...io, remove: true }) });
    } else {
      actions.push({
        kind: 'mcp',
        ...editJson(
          file,
          (d) => {
            const bag = d[spec.key];
            if (bag && typeof bag === 'object') {
              delete bag[SERVER_KEY];
              if (!Object.keys(bag).length) delete d[spec.key];
            }
          },
          io,
        ),
      });
    }
  }

  return { agent: adapter.id, name: adapter.name, actions };
}

/**
 * What is actually wired right now — the raw material for `doctor`.
 * Read-only: it never touches a file.
 */
export function inspect(agentId, { cwd = process.cwd() } = {}) {
  const adapter = byId(agentId);
  if (!adapter) return null;
  const out = { agent: adapter.id, name: adapter.name, confidence: adapter.confidence, hook: null, mcp: null };

  if (adapter.hook) {
    const file = resolveFile(adapter.hook, cwd);
    const raw = readTextSafe(file, null);
    out.hook = { file, present: raw !== null, wired: raw !== null && /note-tree/i.test(raw) && HOOK_FILES.test(raw) };
  }
  if (adapter.mcp) {
    const file = resolveFile(adapter.mcp, cwd);
    const raw = readTextSafe(file, null);
    out.mcp = { file, present: raw !== null, wired: raw !== null && raw.includes(SERVER_KEY) };
  }
  return out;
}

/** Wire several agents at once; `init` uses this with the detected list. */
export function wireAll(agentIds, opts = {}) {
  const ids = agentIds && agentIds.length ? agentIds : ADAPTERS.map((a) => a.id);
  return ids.map((id) => wire(id, opts));
}
