/**
 * Static export.
 *
 * One HTML file with the CSS, the script, the layout *and* the note bodies
 * inlined. No server, no network, no fonts — open it with the wifi off, or put
 * it on GitHub Pages and it becomes a demo people can click.
 *
 * The only behavioural difference from the live page is `live: false`, which
 * turns off SSE and the write actions. Everything else is the same code.
 */

import { renderPage } from './render.mjs';
import { layout } from './tree.mjs';
import { openContext } from '../context.mjs';
import { loadRegistry } from '../index-cache.mjs';
import { existsSync } from 'node:fs';

/** A single pathological note shouldn't turn a demo into a 40 MB download. */
const MAX_BODY_CHARS = 20_000;

/** What a session would pay for this tree — shown in the header. */
function seedCost(ctx) {
  try {
    const seed = ctx.seed();
    return { tokens: seed.tokens, notes: seed.counts.rendered };
  } catch {
    return null;
  }
}

/**
 * Build the document.
 *
 * @param ctx            an open context — the project the export is anchored to
 * @param opts.scope     'project' | 'global' | 'all'
 * @param opts.forest    include every project note-tree knows about
 * @param opts.bodies    embed note bodies (default true; false for a public demo)
 * @returns `{ html, bytes, counts, scopes }`
 */
export function buildExport(ctx, { scope = null, forest = false, bodies = true, now = Date.now() } = {}) {
  const sources = forest ? everyProject(ctx) : [{ label: ctx.slug, ctx }];

  const project = [];
  const global = ctx.entries('global');
  for (const s of sources) {
    for (const entry of s.ctx.entries('project')) project.push(entry);
  }

  const scopes = [];
  if (project.length || !forest) {
    scopes.push({ id: 'project', label: forest ? 'projects' : shortSlug(ctx.slug) || 'project', count: project.length });
  }
  scopes.push({ id: 'global', label: 'global', count: global.length });
  if (project.length) scopes.push({ id: 'all', label: 'both', count: project.length + global.length });

  const chosen = scope && scopes.some((s) => s.id === scope) ? scope : scopes[0].id;

  // Bodies come from whichever store owns the note, which for a forest export
  // is not always `ctx` — so build the lookup once, across every source.
  const readBody = bodies ? bodyLookup([...sources.map((s) => s.ctx), ctx]) : () => undefined;

  const layouts = {};
  for (const tab of scopes) {
    const entries = tab.id === 'project' ? project : tab.id === 'global' ? global : [...project, ...global];
    const built = layout(entries, { now });
    for (const leaf of built.leaves) {
      const body = readBody(leaf.id);
      if (body !== undefined) leaf.body = body;
    }
    layouts[tab.id] = built;
  }

  const data = {
    live: false,
    scope: chosen,
    scopes,
    layouts,
    project: forest ? `${sources.length} projects` : ctx.slug,
    generated: new Date(now).toISOString(),
    theme: ctx.cfg.ui?.theme,
    seed: seedCost(ctx),
  };

  const html = renderPage({
    data,
    layout: layouts[chosen],
    title: `${forest ? 'forest' : ctx.slug || 'note-tree'} · note-tree`,
  });

  return {
    html,
    bytes: Buffer.byteLength(html),
    scopes,
    counts: { project: project.length, global: global.length, projects: sources.length },
  };
}

/**
 * Resolve a note body by id, trying each store in turn.
 *
 * Bodies are read once, up front — the alternative is one `get` per leaf per
 * scope tab, which for a three-tab export is three times the disk work for the
 * same bytes.
 */
function bodyLookup(contexts) {
  const cache = new Map();
  for (const c of contexts) {
    let notes;
    try {
      notes = c.store.list({ scope: 'all', includeArchived: true });
    } catch {
      continue;
    }
    for (const n of notes) {
      if (cache.has(n.id)) continue;
      const body = String(n.body ?? '');
      cache.set(n.id, body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…[truncated for export]` : body);
    }
  }
  return (id) => cache.get(id);
}

/**
 * Every project in the registry, opened against a directory that still exists.
 *
 * A project whose checkout has been deleted keeps its notes — they're in
 * `~/.note-tree`, not the repo — so it stays in the forest.
 */
function everyProject(ctx) {
  const registry = loadRegistry(ctx.paths);
  const slugs = Object.keys(registry.projects || {});
  if (!slugs.length) return [{ label: ctx.slug, ctx }];

  const out = [];
  for (const slug of slugs) {
    if (slug === ctx.slug) {
      out.push({ label: slug, ctx });
      continue;
    }
    const cwds = registry.projects[slug]?.cwds || [];
    const cwd = cwds.find((d) => existsSync(d)) || cwds[0] || ctx.cwd;
    try {
      out.push({ label: slug, ctx: openContext({ cwd, slug, root: ctx.paths.root, withProject: true }) });
    } catch {
      /* an unreadable project is worth skipping, not worth failing the export */
    }
  }
  return out;
}

/** `note-tree-a1b2c3` reads better as `note-tree` on a tab. */
function shortSlug(slug) {
  return slug ? slug.replace(/-[a-z0-9]{6}$/, '') : slug;
}
