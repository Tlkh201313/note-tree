/**
 * Opening the tree.
 *
 * Shared by `note-tree tree` and by the MCP tool `note_manage: open_tree`, which
 * is why the server instance is cached per process: an agent that asks to see
 * the tree three times in one session should get the same tab back, not three
 * more ports.
 */

import { spawn } from 'node:child_process';
import { startServer, DEFAULT_PORT } from './server.mjs';

/** One server per root, for the lifetime of this process. */
const running = new Map();

/**
 * Start (or reuse) the server and point a browser at it.
 *
 * @returns the URL — the caller decides whether to print it.
 */
export async function openTree(ctx, { port = DEFAULT_PORT, open = true, scope = null } = {}) {
  const server = await ensureServer(ctx, { port, scope });
  const url = scope ? `${server.url}?scope=${encodeURIComponent(scope)}` : server.url;
  if (open) openBrowser(url);
  return url;
}

export async function ensureServer(ctx, { port = DEFAULT_PORT, scope = null } = {}) {
  const key = ctx.paths.root;
  const existing = running.get(key);
  if (existing) return existing;

  const server = await startServer(ctx, { port, scope });
  running.set(key, server);
  return server;
}

export async function closeAll() {
  for (const [key, server] of running) {
    running.delete(key);
    try {
      await server.close();
    } catch {
      /* shutting down; nothing left to protect */
    }
  }
}

/**
 * Hand the URL to the desktop.
 *
 * Detached and fully ignored, so a browser that outlives the CLI doesn't keep
 * our process alive — and a machine with no browser at all just prints a URL
 * instead of crashing.
 */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? // `start` is a cmd builtin, and its first quoted argument is the window
        // title — omitting it makes cmd treat the URL as the title and open
        // nothing at all.
        ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      /* no browser, no desktop, or a headless box — the URL is still printed */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
