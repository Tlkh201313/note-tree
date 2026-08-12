/**
 * Helpers every command wants: opening a context, resolving the short ids
 * people actually type, and turning "180d" into milliseconds.
 */

import { openContext } from '../../context.mjs';
import { dim, bold, fail } from '../out.mjs';

/** Notes written from the CLI are attributed to `cli`, not to an agent. */
export function open(args, opts = {}) {
  return openContext({
    cwd: args.cwd,
    root: args.root,
    agent: 'cli',
    session: `cli-${process.pid.toString(36)}`,
    ...opts,
  });
}

/**
 * Resolve an id the way a person typed it: exact match, then unique prefix.
 * Ambiguity is an error rather than a guess — picking the wrong note silently
 * would be worse than asking again.
 */
export function resolveId(ctx, input) {
  const id = String(input || '').trim();
  if (!id) throw new Error('missing note id');

  const exact = ctx.store.get(id);
  if (exact) return exact;

  const all = ctx.allEntries({ reconcile: false });
  const matches = all.filter((n) => n.id.startsWith(id));
  if (matches.length === 1) return ctx.store.get(matches[0].id);
  if (matches.length > 1) {
    throw new Error(
      `"${id}" matches ${matches.length} notes: ${matches.slice(0, 5).map((m) => m.id).join(', ')}${matches.length > 5 ? '…' : ''}`,
    );
  }
  throw new Error(`no note with id "${id}"`);
}

/** Run one action over several ids, reporting each independently. */
export function forEachId(ctx, ids, action) {
  let failures = 0;
  for (const raw of ids) {
    try {
      action(resolveId(ctx, raw));
    } catch (error) {
      fail(error.message);
      failures++;
    }
  }
  return failures ? 1 : 0;
}

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_592_000_000, y: 31_536_000_000 };

/** "180d", "6mo", "2w" → milliseconds. Bare numbers are days. */
export function duration(input, fallback = null) {
  const m = /^(\d+(?:\.\d+)?)\s*(mo|[smhdwy])?$/i.exec(String(input ?? '').trim());
  if (!m) return fallback;
  const unit = (m[2] || 'd').toLowerCase();
  return Number(m[1]) * (UNITS[unit] ?? UNITS.d);
}

/** A short line describing where a command is operating, for `--verbose`. */
export function contextLine(ctx) {
  return dim(`${bold(ctx.slug || 'global only')} ${ctx.paths.root}`);
}
