#!/usr/bin/env node
/**
 * SessionEnd — close the books.
 *
 * `SessionEnd` hooks share a 1.5-second budget across all of them, so this does
 * exactly two things: append one journal line and delete one scratch file. No
 * scanning, no rebuilding, no network.
 *
 * Usage: node session-end.mjs [--agent claude]
 */

import { run, arg, readStdinJson, resolveCwd, resolveSession } from './lib.mjs';
import { loadConfig } from '../src/config.mjs';
import { projectSlug } from '../src/paths.mjs';
import { append } from '../src/journal.mjs';
import { readState, endSession } from '../src/session-state.mjs';

const agent = String(arg('agent', 'claude'));

await run(
  async () => {
    const payload = await readStdinJson(150);
    const sessionId = resolveSession(payload);
    if (!sessionId) return '';

    const cwd = resolveCwd(payload);
    const slug = projectSlug(cwd);
    const cfg = loadConfig({ slug });
    const state = readState(cfg.paths, sessionId);

    append(cfg.paths.journal, {
      ev: 'session-end',
      session: sessionId,
      agent,
      project: slug,
      reason: payload?.reason || null,
      edits: state?.edits ?? null,
      turns: state?.turns ?? null,
      started: state?.started ?? null,
    });

    endSession(cfg.paths, sessionId);
    return ''; // SessionEnd output is never added to context
  },
  { watchdogMs: 900 }, // comfortably inside the 1.5 s shared budget
);
