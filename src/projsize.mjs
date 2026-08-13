/**
 * A rough size of the project on disk, for the tree's roots.
 *
 * A tree standing in a large codebase should look more firmly rooted than one
 * in an empty folder — so the roots thicken with how many source files the
 * project actually has, not just how many notes it holds. This is that count.
 *
 * Deliberately approximate and cheap: a bounded walk that skips the noise (VCS,
 * dependencies, build output, hidden dirs), stops at a ceiling because the roots
 * are visually maxed out long before then, and is cached per directory so the
 * live server never re-walks on a redraw. It never throws — a folder it can't
 * read simply counts as smaller, which just draws a slightly younger root system.
 */

import fs from 'node:fs';
import path from 'node:path';

// Directories that inflate the count without saying anything about the project.
const SKIP = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  'coverage', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
  '__pycache__', '.venv', 'venv', '.gradle', '.mvn',
]);

const CEILING = 20_000; // past here the roots are already at full vigour
const TTL_MS = 60_000; // a project doesn't change size mid-session

const cache = new Map(); // dir -> { at, files }

/**
 * Count source-ish files under `dir`. Hidden entries (dotfiles and dotdirs,
 * `.git` included) are skipped, so the number tracks the working tree a person
 * would recognise as "the project".
 */
export function countProjectFiles(dir, { now = Date.now() } = {}) {
  if (!dir) return 0;
  const hit = cache.get(dir);
  if (hit && now - hit.at < TTL_MS) return hit.files;

  let files = 0;
  const stack = [dir];
  while (stack.length && files < CEILING) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip it, keep counting the rest
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue; // .git, .env, dotdirs — noise
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(path.join(d, e.name));
      } else if (e.isFile()) {
        if (++files >= CEILING) break;
      }
    }
  }

  cache.set(dir, { at: now, files });
  return files;
}
