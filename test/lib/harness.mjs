/**
 * The whole test harness. No dependencies, no framework — an `ok()` that counts
 * and a `report()` that sets the exit code.
 *
 * Every suite runs in its own process (see run.mjs) because several of them
 * redirect HOME before importing note-tree, and module state is per-process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Repository root — everything else is derived, so the suites move freely. */
export const REPO = path.resolve(import.meta.dirname, '..', '..');
/** `file://` base for dynamic imports of the library. */
export const SRC = pathToFileURL(path.join(REPO, 'src')).href;
export const CLI = path.join(REPO, 'bin', 'note-tree.mjs');
export const HOOKS = path.join(REPO, 'hooks');

const VERBOSE = process.env.NT_TEST_VERBOSE === '1' || process.argv.includes('--verbose');

let pass = 0;
const fails = [];
const temps = [];

/**
 * One assertion. `extra` is only printed when it fails — it should be whatever
 * you would have reached for next while debugging (the actual value, usually).
 */
export function ok(label, cond, extra = '') {
  if (cond) {
    pass++;
    if (VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fails.push(`${label}${extra ? ` — ${extra}` : ''}`);
    console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

/** Print the tally in the shape run.mjs parses, and set the exit code. */
export function report() {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  FAIL ' + f);
  process.exitCode = fails.length ? 1 : 0;
}

/** A scratch directory, removed by report() even if assertions failed. */
export function tmpdir(prefix = 'nt-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * node:sqlite exists from Node 22.5 (behind a flag until 24) and is used only to
 * *build* fixtures — the reader note-tree ships is pure JS and supports Node 18.
 * So: try it, retry once with the flag, and skip the suite where it can't exist.
 */
export async function fixtureSqlite(metaUrl) {
  try {
    return await import('node:sqlite');
  } catch {
    /* fall through */
  }
  if (!process.env.NT_SQLITE_RETRY) {
    const file = new URL(metaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const r = spawnSync(process.execPath, ['--experimental-sqlite', file, ...process.argv.slice(2)], {
      stdio: ['inherit', 'inherit', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, NT_SQLITE_RETRY: '1' },
    });
    // A Node too old to know the flag refuses to start at all — that is a skip,
    // not a failure. Anything else is the child's real result, forwarded.
    if (r.status === 0 || !/bad option|not allowed/i.test(r.stderr || '')) {
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    }
  }
  console.log(`skipped — node:sqlite is unavailable on ${process.version} (fixtures only; the shipped reader is pure JS)`);
  process.exit(0);
}
