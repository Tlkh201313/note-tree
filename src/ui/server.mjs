/**
 * The live tree server.
 *
 * `node:http` and nothing else. It exists to do one thing well: serve the page,
 * and push an event the moment any agent — in any terminal, in any CLI — saves
 * a note, so a leaf sprouts while you watch.
 *
 * Security posture, because this serves your memory over a socket:
 *   - binds to 127.0.0.1 only, never 0.0.0.0
 *   - rejects requests whose `Host` isn't loopback (DNS-rebinding defence)
 *   - rejects cross-origin requests outright
 *   - no directory serving; every route is enumerated below
 */

import http from 'node:http';
import fs from 'node:fs';
import { renderPage, scopeTabs } from './render.mjs';
import { layout } from './tree.mjs';
import { since, size } from '../journal.mjs';

export const DEFAULT_PORT = 4747;
const HOST = '127.0.0.1';

/** How often we look for new journal lines. Cheap: one `stat` unless it grew. */
const POLL_MS = 400;
/** SSE comment keepalive, so proxies and sleeping laptops don't drop the stream. */
const KEEPALIVE_MS = 25_000;

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

/**
 * Entries for a scope tab.
 * `all` merges both trees, which is what you want when you're looking for a
 * note and can't remember where you filed it.
 */
function entriesFor(ctx, scope) {
  if (scope === 'global') return ctx.entries('global', { reconcile: true });
  if (scope === 'all') return ctx.allEntries({ reconcile: true });
  return ctx.entries('project', { reconcile: true });
}

function pageData(ctx, scope) {
  const project = ctx.slug ? ctx.entries('project').length : 0;
  const global = ctx.entries('global').length;
  return {
    live: true,
    scope,
    scopes: scopeTabs({ project, global, slug: ctx.slug }),
    project: ctx.slug,
    root: ctx.paths.root,
  };
}

/**
 * Start listening.
 *
 * @returns `{ url, port, close() }`
 */
export async function startServer(ctx, { port = DEFAULT_PORT, scope = null } = {}) {
  const initialScope = scope || (ctx.slug ? 'project' : 'global');
  const clients = new Set();
  let cursor = size(ctx.paths.journal);

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      send(res, 500, { error: String(error?.message || error) });
    }
  });

  function handle(req, res) {
    // Same-origin only. A page on another site must not be able to read your
    // notes just because this port happens to be open.
    const host = req.headers.host || '';
    if (!LOOPBACK.test(host)) return send(res, 403, { error: 'not a loopback host' });
    const origin = req.headers.origin;
    if (origin && !LOOPBACK.test(new URL(origin).host)) return send(res, 403, { error: 'cross-origin' });

    const url = new URL(req.url, `http://${host}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/' && req.method === 'GET') {
      const scopeNow = url.searchParams.get('scope') || initialScope;
      const html = renderPage({
        data: pageData(ctx, scopeNow),
        layout: layout(entriesFor(ctx, scopeNow)),
        title: `${ctx.slug || 'note-tree'} · note-tree`,
      });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The page runs only its own inlined script; say so.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'",
        'x-content-type-options': 'nosniff',
      });
      return res.end(html);
    }

    if (route === '/api/layout' && req.method === 'GET') {
      const scopeNow = url.searchParams.get('scope') || initialScope;
      return send(res, 200, layout(entriesFor(ctx, scopeNow)));
    }

    if (route === '/api/forest' && req.method === 'GET') {
      return send(res, 200, forest(ctx));
    }

    if (route.startsWith('/api/note/') && req.method === 'GET') {
      const id = decodeURIComponent(route.slice('/api/note/'.length));
      const note = ctx.store.get(id);
      if (!note) return send(res, 404, { error: 'no such note' });
      // Opening a note in the tree is a recall, and recall feeds ranking — the
      // notes you actually revisit should rise in tomorrow's seed.
      try {
        ctx.store.markRead([note.id]);
      } catch {
        /* ranking is a nicety; showing the note is the job */
      }
      return send(res, 200, {
        id: note.id,
        title: note.title,
        desc: note.desc || '',
        body: note.body || '',
        kind: note.kind,
        scope: note.scope,
        tags: note.tags || [],
        agent: note.agent || null,
        created: note.created,
        updated: note.updated,
        reads: note.reads || 0,
        pinned: Boolean(note.pinned),
        archived: Boolean(note.archived),
      });
    }

    if (route === '/api/manage' && req.method === 'POST') {
      return readBody(req, (body) => {
        const { action, id } = body || {};
        const fn = {
          pin: () => (ctx.store.get(id)?.pinned ? ctx.store.unpin(id) : ctx.store.pin(id)),
          archive: () => (ctx.store.get(id)?.archived ? ctx.store.restore(id) : ctx.store.archive(id)),
          promote: () => (ctx.store.get(id)?.scope === 'global' ? ctx.store.demote(id) : ctx.store.promote(id)),
        }[action];
        if (!fn) return send(res, 400, { error: `unknown action "${action}"` });
        try {
          const note = fn();
          if (!note) return send(res, 404, { error: 'no such note' });
          return send(res, 200, { ok: true, id: note.id, scope: note.scope });
        } catch (error) {
          return send(res, 400, { error: String(error?.message || error) });
        }
      });
    }

    if (route === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }

    return send(res, 404, { error: 'not found' });
  }

  /**
   * Watch the journal.
   *
   * Polling a size beats `fs.watch` here: it behaves identically on every
   * platform, survives atomic-rename writes and log rotation, and one `stat`
   * every 400 ms is beneath measurement.
   */
  const poll = setInterval(() => {
    if (!clients.size) {
      // Nobody's looking — keep the cursor current so reconnecting doesn't
      // replay the whole file as a burst of sprouts.
      cursor = size(ctx.paths.journal);
      return;
    }
    const now = size(ctx.paths.journal);
    if (now < cursor) cursor = 0; // rotated out from under us
    const { events, cursor: next } = since(ctx.paths.journal, cursor);
    cursor = next;
    for (const ev of events) {
      if (ev.ev === 'read') continue; // a recall is not new growth
      broadcast('note', { id: ev.id, ev: ev.ev, scope: ev.scope, title: ev.title, agent: ev.agent });
    }
  }, POLL_MS);
  poll.unref?.();

  const beat = setInterval(() => broadcastRaw(': ping\n\n'), KEEPALIVE_MS);
  beat.unref?.();

  function broadcast(event, data) {
    broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcastRaw(chunk) {
    for (const res of clients) {
      try {
        res.write(chunk);
      } catch {
        clients.delete(res);
      }
    }
  }

  const bound = await listen(server, port);

  return {
    url: `http://${HOST}:${bound}/`,
    port: bound,
    close() {
      clearInterval(poll);
      clearInterval(beat);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      clients.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Bind, walking forward if the port is taken.
 *
 * A second `note-tree tree` shouldn't die because the first one is still up —
 * it should just open next door.
 */
function listen(server, wanted, attempts = 12) {
  return new Promise((resolve, reject) => {
    let port = Number(wanted) || DEFAULT_PORT;
    let left = attempts;

    const onError = (error) => {
      if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && left-- > 0) {
        server.removeListener('error', onError);
        server.once('error', onError);
        server.listen(++port, HOST);
        return;
      }
      reject(error);
    };

    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

/** Every project note-tree has seen, for the forest view. */
function forest(ctx) {
  let reg = {};
  try {
    reg = JSON.parse(fs.readFileSync(ctx.paths.index, 'utf8'));
  } catch {
    reg = {};
  }
  return {
    here: ctx.slug,
    projects: Object.values(reg.projects || {}).map((p) => ({
      slug: p.slug,
      count: p.count || 0,
      updated: p.updated || null,
      cwds: p.cwds || [],
    })),
    global: reg.global?.count || 0,
  };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** Small bodies only — this endpoint takes `{action, id}` and nothing larger. */
function readBody(req, done) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 8192) req.destroy();
  });
  req.on('end', () => {
    try {
      done(raw ? JSON.parse(raw) : {});
    } catch {
      done(null);
    }
  });
}
