#!/usr/bin/env node
/**
 * note-tree MCP server — JSON-RPC 2.0 over stdio, hand-rolled, zero dependencies.
 *
 * Why no SDK: this process starts every time an agent starts. The SDK pulls in
 * a dependency tree that costs more to load than everything this server does.
 * The protocol surface we need is four methods, and they fit on one screen.
 *
 * Why only five tools: tool schemas are re-injected into context on every
 * session, so tool count *is* token cost. Each one here has to earn its place.
 *
 * Nothing but JSON-RPC ever goes to stdout — a stray `console.log` would
 * corrupt the stream. Diagnostics go to stderr.
 *
 * Usage: node server.mjs [--agent claude] [--cwd <dir>]
 */

import path from 'node:path';
import { openContext } from '../src/context.mjs';
import { renderNote } from '../src/seed.mjs';
import { adoptSession } from '../src/session-state.mjs';
import { KINDS } from '../src/config.mjs';

const SERVER_NAME = 'note-tree';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2025-06-18';

function argv(name, fallback = null) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1] ?? true;
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return fallback;
}

const agent = String(argv('agent', 'mcp'));
const cwd = path.resolve(String(argv('cwd', process.cwd())));

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

/**
 * Descriptions are terse on purpose: this JSON is re-sent on every session, so
 * every word here is a recurring cost. The long "what deserves a note" guidance
 * lives in the bundled skill, which loads only when it's relevant.
 */
const TOOLS = [
  {
    name: 'note_write',
    description:
      'Save one durable fact: a decision and why, a convention, a gotcha that cost time, or a stable architectural fact. Not task status or anything re-derivable from the code. ~150 words max.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'The fact and why it matters' },
        kind: { type: 'string', enum: KINDS },
        tags: { type: 'array', items: { type: 'string' } },
        scope: { type: 'string', enum: ['project', 'global'], description: 'global = true everywhere' },
        id: { type: 'string', description: 'update this note' },
        supersedes: { type: 'string' },
        force: { type: 'boolean', description: 'save despite a near-duplicate' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'note_read',
    description: 'Full text of notes by id. Batch ids into one call.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
  },
  {
    name: 'note_search',
    description: 'Search memory. Filters: kind: tag: scope: agent: pinned:, "phrase", -exclude.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        deep: { type: 'boolean', description: 'search bodies too' },
      },
      required: ['query'],
    },
  },
  {
    name: 'note_manage',
    description: 'Curate memory. promote = make a project note global. open_tree = show the tree.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['archive', 'restore', 'pin', 'unpin', 'promote', 'demote', 'open_tree'],
        },
        id: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'note_seed',
    description: 'Re-read this project’s ranked memory block.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* ------------------------------------------------------------------ *
 * Lazy context — nothing touches disk until a tool is actually called
 * ------------------------------------------------------------------ */

let ctx = null;
function context() {
  if (!ctx) {
    ctx = openContext({ cwd, agent });
    // The agent never tells an MCP server its session id, so infer it from the
    // session that just started in this directory. Notes then land on the same
    // branch of the tree as the work that produced them.
    ctx.session = adoptSession(ctx.paths, cwd);
  }
  return ctx;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const failure = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

const HANDLERS = {
  note_write(args) {
    const c = context();
    const result = c.write(
      {
        title: args.title,
        body: args.body,
        kind: args.kind,
        tags: args.tags,
        scope: args.scope,
        id: args.id,
        supersedes: args.supersedes,
      },
      { force: Boolean(args.force) },
    );

    if (result.status === 'duplicate') {
      const d = result.duplicate;
      return text(
        `Not saved — this is ${Math.round(d.score * 100)}% similar to an existing note:\n` +
          `  ${d.id} · ${d.kind} · ${d.title}\n` +
          `Update it instead (note_write with id: "${d.id}"), or pass force: true if it is genuinely different.`,
      );
    }

    const lines = [`Saved ${result.note.id} (${result.status}, ${result.note.scope}).`];
    for (const w of result.warnings) lines.push(`note: ${w}`);
    return text(lines.join('\n'));
  },

  note_read(args) {
    const c = context();
    const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).filter(Boolean).slice(0, 20);
    if (!ids.length) return failure('note_read needs at least one id');

    const found = [];
    const missing = [];
    for (const id of ids) {
      const note = c.store.get(String(id));
      if (note) found.push(note);
      else missing.push(id);
    }
    if (found.length) c.store.markRead(found.map((n) => n.id));

    const body = found.map((n) => renderNote(n)).join('\n\n---\n\n');
    const tail = missing.length ? `\n\n(not found: ${missing.join(', ')})` : '';
    return found.length ? text(body + tail) : failure(`No notes found for: ${ids.join(', ')}`);
  },

  note_search(args) {
    const c = context();
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const hits = c.search(String(args.query ?? ''), { limit, deep: Boolean(args.deep) });
    if (!hits.length) return text(`No notes match: ${args.query}`);
    return text(
      hits
        .map((n) => `${n.id} · ${n.kind} · ${n.scope} · ${n.title}${n.desc ? `\n    ${n.desc}` : ''}`)
        .join('\n'),
    );
  },

  async note_manage(args) {
    const c = context();
    const action = String(args.action || '');

    if (action === 'open_tree') {
      const { openTree } = await import('../src/ui/launch.mjs');
      const url = await openTree(c);
      return text(`Tree opened: ${url}`);
    }

    const id = String(args.id || '');
    if (!id) return failure(`note_manage action "${action}" needs an id`);

    const fn = {
      archive: () => c.store.archive(id),
      restore: () => c.store.restore(id),
      pin: () => c.store.pin(id),
      unpin: () => c.store.unpin(id),
      promote: () => c.store.promote(id),
      demote: () => c.store.demote(id),
    }[action];
    if (!fn) return failure(`Unknown action "${action}"`);

    const note = fn();
    if (!note) return failure(`No note with id "${id}"`);
    return text(`${action}: ${note.id} · ${note.scope} · ${note.title}`);
  },

  note_seed() {
    const c = context();
    const seed = c.seed({ recall: 'note_read(ids)' });
    if (!seed) return text('Memory is empty for this project. Save the first note with note_write.');
    return text(seed.text);
  },
};

/* ------------------------------------------------------------------ *
 * JSON-RPC
 * ------------------------------------------------------------------ */

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  if (id === undefined || id === null) return; // notification: no response
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return reply(id, {
        // Echo the client's version when it looks valid — being liberal here is
        // what makes one server work across clients on different spec dates.
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'initialized':
      return; // no response to notifications
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) return replyError(id, -32602, `Unknown tool: ${name}`);
      try {
        return reply(id, await handler(params?.arguments || {}));
      } catch (err) {
        // A failed tool call is a result, not a protocol error — the agent
        // should see the message and be able to correct itself.
        return reply(id, failure(`note-tree: ${err?.message || String(err)}`));
      }
    }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    try {
      if (Array.isArray(msg)) for (const m of msg) await handle(m);
      else await handle(msg);
    } catch (err) {
      replyError(msg?.id, -32603, `Internal error: ${err?.message || String(err)}`);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
