/**
 * One place that assembles config + store + index, so the CLI, the MCP server
 * and the hooks all behave identically. Anything with write access goes through
 * here; the SessionStart hot path uses the lighter `recall.mjs` instead.
 */

import { loadConfig } from './config.mjs';
import { projectSlug } from './paths.mjs';
import { openStore } from './store/index.mjs';
import * as idx from './index-cache.mjs';
import { renderSeed } from './seed.mjs';
import { search as runSearch } from './search.mjs';
import { rankNotes } from './rank.mjs';
import { byId } from './agents/registry.mjs';
import { refreshAll } from './agents/contextfile.mjs';

export function openContext({
  cwd = process.cwd(),
  root = null,
  agent = null,
  session = null,
  withProject = true,
  // `sync --all` walks projects it isn't standing in, so the slug can be given
  // directly instead of derived from the working directory.
  slug: explicitSlug = null,
} = {}) {
  const slug = withProject ? explicitSlug || projectSlug(cwd) : null;
  const cfg = loadConfig({ root, slug });

  let store;
  let ctx;
  store = openStore(cfg, {
    onChange(event) {
      idx.applyChange(store, event);
      if (event.ev !== 'read') {
        idx.touchRegistry(store, {
          slug,
          cwd,
          counts: {
            project: idx.loadIndex(cfg.paths, 'project').notes.filter((n) => !n.archived).length,
            global: idx.loadIndex(cfg.paths, 'global').notes.filter((n) => !n.archived).length,
          },
        });
        // Tier B has no session hook to keep it honest, so the generated block
        // is rewritten here — the moment memory changes, from any agent.
        ctx?.refreshContextFiles();
      }
    },
  });

  ctx = {
    cfg,
    slug,
    cwd,
    agent,
    session,
    store,
    paths: cfg.paths,

    /** Note metadata for a scope, repaired first if something changed on disk. */
    entries(scope, opts = {}) {
      return idx.entries(store, scope, opts);
    },

    /** Both scopes, tagged so callers can tell them apart after merging. */
    allEntries(opts = {}) {
      return [...ctx.entries('project', opts), ...ctx.entries('global', opts)];
    },

    // Attribution is read at call time, so a caller that learns its session id
    // late (an MCP server, say) can set `ctx.session` and have it apply.
    write(input, opts = {}) {
      return store.write(input, { project: slug, agent: ctx.agent, session: ctx.session }, opts);
    },

    search(query, opts = {}) {
      return runSearch(store, ctx.allEntries(), query, cfg, opts);
    },

    ranked(scope = 'all', opts = {}) {
      const list = scope === 'all' ? ctx.allEntries(opts) : ctx.entries(scope, opts);
      return rankNotes(list, cfg, opts);
    },

    /** The exact text a session would receive. `null` when there's nothing to say. */
    seed(opts = {}) {
      return renderSeed(ctx.entries('project'), ctx.entries('global'), cfg, {
        project: slug,
        ...opts,
      });
    },

    /**
     * Adapters wired for this project that read a generated context block.
     * Empty until `note-tree init` fills `agents.enabled`, so note-tree never
     * drops a file into a repo you didn't ask it to.
     */
    contextAdapters() {
      return (cfg.agents?.enabled || [])
        .map(byId)
        .filter((a) => a && a.contextFile && !a.contextFile.fallbackOnly);
    },

    /**
     * Rewrite every Tier B block. Safe to call often — an unchanged block is a
     * no-op — and it can never throw into a caller that just saved a note.
     */
    refreshContextFiles(opts = {}) {
      try {
        const adapters = ctx.contextAdapters();
        return adapters.length ? refreshAll(ctx, adapters, opts) : [];
      } catch {
        return [];
      }
    },

    /** Full rebuild of both indexes from note files — what `sync` runs. */
    reindex() {
      const out = {};
      for (const scope of slug ? ['project', 'global'] : ['global']) {
        const doc = idx.rebuild(store, scope);
        out[scope] = doc ? doc.count : 0;
      }
      idx.touchRegistry(store, { slug, cwd, counts: { project: out.project || 0, global: out.global || 0 } });
      // Hand-edited notes change what the block should say, so `sync` proves
      // Tier B is current rather than assuming it.
      out.contextFiles = ctx.refreshContextFiles({ force: true });
      return out;
    },
  };

  return ctx;
}
