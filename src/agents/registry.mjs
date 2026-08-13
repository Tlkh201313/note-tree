/**
 * The adapter registry — one declarative entry per agent CLI.
 *
 * Adding support for a new tool should be a pull request that adds one object
 * to this file, not a code change. That is deliberate: it is the most likely
 * kind of contribution note-tree will get, so it is the one made trivial.
 *
 * Three delivery tiers, best available wins:
 *
 *   A  native session hook   — ranked seed, always fresh, zero idle cost
 *   B  generated context block — for tools with no hook API; a marker-fenced
 *                                section in the instructions file they already read
 *   C  MCP tools             — read/write/search from inside the agent
 *
 * `confidence` is honest, not marketing. `verified` means the paths come from
 * first-party documentation; `community` means they don't, and those adapters
 * are labelled experimental in the README and by `note-tree adapters`.
 */

import path from 'node:path';
import { HOME } from '../paths.mjs';

const h = (...parts) => path.join(HOME, ...parts);

/**
 * @typedef {object} Adapter
 * @property {string}  id
 * @property {string}  name
 * @property {string[]} tiers        which of A/B/C this adapter supports
 * @property {'verified'|'community'} confidence
 * @property {string[]} detect       paths that indicate the CLI is installed
 * @property {object}  [hook]        Tier A wiring
 * @property {object}  [mcp]         Tier C wiring
 * @property {object}  [contextFile] Tier B wiring
 * @property {string}  [note]        caveat shown by `note-tree adapters`
 */

/** @type {Adapter[]} */
export const ADAPTERS = [
  {
    id: 'claude',
    name: 'Claude Code',
    tiers: ['A', 'C'],
    confidence: 'verified',
    detect: [h('.claude'), h('.claude.json')],
    hook: {
      scope: 'user',
      file: h('.claude', 'settings.json'),
      format: 'claude-settings',
      events: { SessionStart: 'session-start.mjs', Stop: 'stop-nudge.mjs', SessionEnd: 'session-end.mjs' },
    },
    mcp: { scope: 'project', file: '.mcp.json', format: 'json', key: 'mcpServers' },
    // The plugin ships the skill; an npm install has to place it, or agents get
    // memory injected with no guidance on what deserves saving — and a tree
    // that only ever grows when a human runs the CLI by hand.
    skill: { dir: h('.claude', 'skills', 'note-tree'), source: path.join('skills', 'note-tree', 'SKILL.md') },
    contextFile: { file: 'CLAUDE.md', fallbackOnly: true },
    note: 'Installing the plugin wires hooks automatically; --install-hooks is for non-plugin setups.',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    tiers: ['A', 'B', 'C'],
    confidence: 'verified',
    detect: [h('.codex')],
    hook: {
      scope: 'user',
      file: h('.codex', 'hooks.json'),
      format: 'codex-hooks',
      events: { SessionStart: 'session-start.mjs' },
    },
    mcp: { scope: 'user', file: h('.codex', 'config.toml'), format: 'toml', key: 'mcp_servers' },
    contextFile: { file: 'AGENTS.md' },
    note: 'Hooks are stable from v0.124.0. If your Codex predates that, Tier B still works.',
  },
  {
    id: 'opencode',
    name: 'opencode',
    tiers: ['A', 'B', 'C'],
    confidence: 'verified',
    detect: [h('.config', 'opencode'), h('.opencode')],
    hook: {
      scope: 'user',
      file: h('.config', 'opencode', 'plugin', 'note-tree.js'),
      format: 'opencode-plugin',
      events: { SessionStart: 'session-start.mjs' },
      // The injection point is the least-documented part of opencode's plugin
      // API. The generated plugin no-ops on any surprise, and AGENTS.md carries
      // memory regardless — so this is safe to attempt, not safe to promise.
      experimental: true,
    },
    mcp: { scope: 'user', file: h('.config', 'opencode', 'opencode.json'), format: 'json', key: 'mcp' },
    contextFile: { file: 'AGENTS.md' },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    tiers: ['B', 'C'],
    confidence: 'verified',
    detect: [h('.kiro'), '.kiro'],
    mcp: { scope: 'project', file: path.join('.kiro', 'settings', 'mcp.json'), format: 'json', key: 'mcpServers' },
    contextFile: {
      file: path.join('.kiro', 'steering', 'note-tree.md'),
      frontmatter: { inclusion: 'auto' },
    },
    note: 'Kiro has no session-start hook, so memory arrives via a steering file. MCP hot-reloads.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    tiers: ['B', 'C'],
    confidence: 'verified',
    detect: [h('.gemini')],
    mcp: { scope: 'user', file: h('.gemini', 'settings.json'), format: 'json', key: 'mcpServers' },
    contextFile: { file: 'GEMINI.md' },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    tiers: ['B', 'C'],
    confidence: 'community',
    detect: [h('.cursor'), '.cursor'],
    mcp: { scope: 'project', file: path.join('.cursor', 'mcp.json'), format: 'json', key: 'mcpServers' },
    contextFile: { file: path.join('.cursor', 'rules', 'note-tree.mdc'), frontmatter: { alwaysApply: true } },
    note: 'Paths are community-documented rather than first-party. Run `note-tree doctor` after wiring.',
  },
  {
    id: 'agents-md',
    name: 'AGENTS.md (Windsurf, Zed, Aider, Amp, goose, Copilot, Warp, Devin, …)',
    tiers: ['B'],
    confidence: 'verified',
    detect: ['AGENTS.md'],
    contextFile: { file: 'AGENTS.md' },
    note: 'The open standard read by 28+ tools. One block reaches all of them.',
  },
];

export const byId = (id) => ADAPTERS.find((a) => a.id === id) || null;

/** Highest tier this adapter can actually deliver. */
export function bestTier(adapter) {
  return adapter.tiers.includes('A') ? 'A' : adapter.tiers.includes('B') ? 'B' : 'C';
}

/**
 * Which CLIs look installed. `exists` is injected so this stays pure and
 * testable — the caller decides what "installed" means on their machine.
 */
export function detectInstalled(exists, cwd = process.cwd()) {
  return ADAPTERS.filter((a) =>
    (a.detect || []).some((d) => exists(path.isAbsolute(d) ? d : path.join(cwd, d))),
  );
}

/**
 * The MCP server entry every JSON-based config wants.
 *
 * `node` rather than an absolute interpreter path, so the wiring survives a
 * Node upgrade or an nvm switch. GUI-launched editors sometimes have a thinner
 * PATH, which is what `--absolute-node` (and `doctor`'s check) is for.
 */
export function mcpEntry(pluginRoot, agentId, { nodeBin = 'node' } = {}) {
  return {
    command: nodeBin,
    args: [posix(path.join(pluginRoot, 'mcp', 'server.mjs')), '--agent', agentId],
  };
}

/** Forward slashes everywhere: valid on Windows, and avoids JSON/TOML escaping. */
export function posix(p) {
  return String(p).split(path.sep).join('/');
}
