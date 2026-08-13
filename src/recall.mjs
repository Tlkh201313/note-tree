/**
 * The hot path.
 *
 * This is what runs on every session start, in every agent, forever — so it is
 * the one module in the codebase optimised for *not doing things*. It imports
 * seven small modules, reads two small JSON files, does one `stat` per scope,
 * and prints. No store, no drivers, no note files, no network, no daemon.
 *
 * The store is loaded lazily, and only when the cache is genuinely out of date.
 */

import { loadConfig } from './config.mjs';
import { projectSlug } from './paths.mjs';
import { loadIndex, isStale } from './index-cache.mjs';
import { renderSeed } from './seed.mjs';

/**
 * Resolve everything a session-start needs.
 *
 * @param opts.recallHint  how this agent fetches a full note
 * @param opts.saveHint    how this agent saves one — the tree stops growing without it
 * @param opts.repair  allow a lazy store load to repair a stale index (default true)
 * @returns `{ cfg, slug, seed, stale }` — `seed` is null when there's nothing to inject
 */
export async function recall({
  cwd = process.cwd(),
  root = null,
  recallHint = 'note_read(id)',
  saveHint = 'note_write',
  repair = true,
  now = Date.now(),
} = {}) {
  const slug = projectSlug(cwd);
  const cfg = loadConfig({ root, slug });
  const p = cfg.paths;
  const format = cfg.storage?.format || 'markdown';

  let projectDoc = loadIndex(p, 'project');
  let globalDoc = loadIndex(p, 'global');

  const staleProject = isStale(p, 'project', format, projectDoc);
  const staleGlobal = isStale(p, 'global', format, globalDoc);
  let repaired = false;

  if (repair && (staleProject || staleGlobal)) {
    // Only now do we pay for the store — and `reconcile` reads just the note
    // files that appeared or vanished, not the whole tree.
    try {
      const [{ openStore }, { reconcile }] = await Promise.all([
        import('./store/index.mjs'),
        import('./index-cache.mjs'),
      ]);
      const store = openStore(cfg);
      if (staleProject && p.projectDir) projectDoc = reconcile(store, 'project');
      if (staleGlobal) globalDoc = reconcile(store, 'global');
      repaired = true;
    } catch {
      // Fall through with whatever the cache had. Slightly stale memory beats
      // no memory, and never breaks the session.
    }
  }

  const seed = renderSeed(projectDoc.notes || [], globalDoc.notes || [], cfg, {
    project: slug,
    recall: recallHint,
    save: saveHint,
    now,
  });

  return { cfg, slug, seed, repaired, stale: { project: staleProject, global: staleGlobal } };
}
