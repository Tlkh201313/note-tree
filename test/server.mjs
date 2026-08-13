/**
 * Drive the real `note-tree tree` server end to end: spawn the CLI exactly as a
 * user would, wait for the URL it prints, probe every route, prove SSE fires
 * when another process writes a note, then shut it down.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { ok, report, tmpdir, CLI } from './lib/harness.mjs';

const rawRequest = (port, request) =>
  new Promise((resolve, reject) => {
    let buf = '';
    const sock = net.connect(port, '127.0.0.1', () => sock.write(request));
    sock.setEncoding('utf8');
    sock.on('data', (d) => (buf += d));
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    setTimeout(() => {
      sock.destroy();
      resolve(buf);
    }, 3000);
  });

const SANDBOX = tmpdir('nt-server-');
const HOME = path.join(SANDBOX, 'home');
const PROJ = path.join(SANDBOX, 'proj');
fs.mkdirSync(PROJ, { recursive: true });
const ENV = {
  ...process.env,
  USERPROFILE: HOME,
  HOME,
  NOTE_TREE_HOME: path.join(HOME, '.note-tree'),
  FORCE_COLOR: '0',
};


for (const [title, body, kind] of [
  ['Pagination is cursor-based, never offset', 'Offset pages drift when rows are inserted mid-scan; every list endpoint takes a cursor.', 'gotcha'],
  ['Migrations run before the image rolls out', 'The deploy job blocks on migrate; a rollback needs a down-migration first.', 'architecture'],
  ['Timestamps are stored as UTC epoch millis', 'Local time only ever appears at the render layer.', 'convention'],
]) {
  const r = spawnSync(process.execPath, [CLI, 'add', title, '--body', body, '--kind', kind, '--force'], { cwd: PROJ, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not seed the sandbox: ' + (r.stderr || r.stdout));
}

const child = spawn(process.execPath, [CLI, 'tree', '--no-open', '--port', '4919'], {
  cwd: PROJ,
  env: ENV,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let errOut = '';
child.stdout.on('data', (c) => (out += c));
child.stderr.on('data', (c) => (errOut += c));

const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no url printed in 8s.\nstdout:${out}\nstderr:${errOut}`)), 8000);
  const tick = setInterval(() => {
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
    if (m) {
      clearInterval(tick);
      clearTimeout(timer);
      resolve(m[0]);
    }
  }, 60);
  child.on('exit', (code) => reject(new Error(`server exited early (${code})\n${out}\n${errOut}`)));
});

console.log(`server up at ${url}`);
const base = url.replace(/\/$/, '');

try {
  /* ---------------------------------------------------------------- page --- */
  const page = await fetch(base + '/');
  ok('GET / is 200', page.status === 200, `got ${page.status}`);
  ok('GET / is html', /text\/html/.test(page.headers.get('content-type') || ''));
  ok('CSP header set', /default-src 'none'/.test(page.headers.get('content-security-policy') || ''));
  ok('nosniff set', page.headers.get('x-content-type-options') === 'nosniff');
  const html = await page.text();
  const data = JSON.parse(html.match(/const DATA = (\{[\s\S]*?\});\n/)[1]);
  ok('page is live', data.live === true);
  ok('page has scopes', Array.isArray(data.scopes) && data.scopes.length >= 2, JSON.stringify(data.scopes));
  ok('no raw U+2028/2029 in html', !/[\u2028\u2029]/.test(html));
  ok('script tags balanced', (html.match(/<script/g) || []).length === (html.match(/<\/script>/g) || []).length);

  // The theme has to be decided before the first paint, or every load flashes
  // the wrong one. That means an inline script in <head>, above the stylesheet
  // it overrides \u2014 not a line in app.js that runs after the page is drawn.
  const head = html.slice(0, html.indexOf('</head>'));
  ok('theme resolves in <head>', /localStorage\.getItem\('note-tree:theme'\)/.test(head));
  ok('theme script follows the stylesheet it overrides', /r\.dataset\.theme/.test(head) && head.indexOf('r.dataset.theme') > head.indexOf('</style>'));
  ok('day runs 07:00-19:00 local', /h >= 7 && h < 19/.test(head));
  ok('both palettes ship', /--k-gotcha/.test(head) && /\[data-theme='night'\]/.test(head));

  /* -------------------------------------------------------------- layout --- */
  const layout = await (await fetch(`${base}/api/layout?scope=all`)).json();
  ok('layout has leaves', Array.isArray(layout.leaves), JSON.stringify(Object.keys(layout)));
  ok('layout leaves carry no bodies', layout.leaves.every((l) => !('body' in l)));
  const first = layout.leaves[0];
  ok('layout not empty', Boolean(first));

  /* -------------------------------------------------------------- forest --- */
  const forest = await (await fetch(`${base}/api/forest`)).json();
  ok('forest lists projects', Array.isArray(forest.projects), JSON.stringify(forest).slice(0, 120));

  /* ---------------------------------------------------------------- note --- */
  const note = await (await fetch(`${base}/api/note/${first.id}`)).json();
  ok('note has a body', typeof note.body === 'string' && note.body.length > 0);
  ok('note id round-trips', note.id === first.id);
  const missing = await fetch(`${base}/api/note/definitely-not-a-note`);
  ok('unknown note is 404', missing.status === 404, `got ${missing.status}`);

  /* -------------------------------------------------------------- manage --- */
  const pinOn = await (await fetch(`${base}/api/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pin', id: first.id }),
  })).json();
  ok('pin succeeds', pinOn.ok === true, JSON.stringify(pinOn));
  const pinOff = await (await fetch(`${base}/api/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pin', id: first.id }),
  })).json();
  ok('pin toggles back off', pinOff.ok === true);
  const bogus = await fetch(`${base}/api/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'detonate', id: first.id }),
  });
  ok('unknown action is 400', bogus.status === 400, `got ${bogus.status}`);

  /* ------------------------------------------------------------ security --- */
  const crossOrigin = await fetch(base + '/', { headers: { origin: 'https://evil.example' } });
  ok('cross-origin rejected', crossOrigin.status === 403, `got ${crossOrigin.status}`);
  // `fetch` silently drops a `Host` override (it's a forbidden header), so the
  // DNS-rebinding defence has to be probed with a raw socket to mean anything.
  const badHost = await rawRequest(Number(new URL(url).port), 'GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
  ok('non-loopback Host rejected', /^HTTP\/1\.1 403/.test(badHost), badHost.split('\r\n')[0]);
  const goodHost = await rawRequest(Number(new URL(url).port), 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  ok('loopback Host accepted', /^HTTP\/1\.1 200/.test(goodHost), goodHost.split('\r\n')[0]);
  const notFound = await fetch(base + '/../package.json');
  ok('no directory traversal', notFound.status === 404, `got ${notFound.status}`);

  /* ----------------------------------------------------------------- SSE --- */
  const sse = await fetch(base + '/events', { headers: { accept: 'text/event-stream' } });
  ok('SSE is event-stream', /text\/event-stream/.test(sse.headers.get('content-type') || ''));

  const reader = sse.body.getReader();
  const seen = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    while (seen.length < 1) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const block of chunk.split('\n\n')) {
        const m = block.match(/^event: (\w+)\ndata: (.*)$/m);
        if (m) seen.push({ event: m[1], data: JSON.parse(m[2]) });
      }
    }
  })();

  // Another process saves a note — exactly the cross-terminal case.
  await new Promise((r) => setTimeout(r, 250));
  const add = spawnSync(
    process.execPath,
    [CLI, 'add', 'A leaf sprouted while you watched', '--body', 'Written from a second process to prove the live stream works.', '--kind', 'reference', '--force'],
    { cwd: PROJ, env: ENV, encoding: 'utf8' },
  );
  ok('second process wrote a note', add.status === 0, add.stderr || add.stdout);

  await Promise.race([pump, new Promise((r) => setTimeout(r, 4000))]);
  ok('SSE pushed a note event', seen.some((e) => e.event === 'note'), JSON.stringify(seen));
  await reader.cancel().catch(() => {});

  /* ----------------------------------------------- layout reflects growth --- */
  const after = await (await fetch(`${base}/api/layout?scope=all`)).json();
  ok('layout grew', after.leaves.length === layout.leaves.length + 1, `${layout.leaves.length} -> ${after.leaves.length}`);
} finally {
  child.kill();
}

/* -------------------------------------------------------------- export --- */
// The static export is the demo, the GitHub Pages page, and the file you can
// open with the network off — it has to be the same app, theme and all.
const htmlOut = path.join(SANDBOX, 'tree.html');
const exported = spawnSync(process.execPath, [CLI, 'export', '--out', htmlOut], { cwd: PROJ, env: ENV, encoding: 'utf8' });
ok('export wrote a file', exported.status === 0 && fs.existsSync(htmlOut), exported.stderr || exported.stdout);
const file = fs.readFileSync(htmlOut, 'utf8');
ok('export is self-contained', !/<(link|img|script)[^>]+(href|src)=["']?https?:/i.test(file));
ok('export carries both palettes', /--paper: #faf9f5/.test(file) && /\[data-theme='night'\]/.test(file));
ok('export follows the clock too', /h >= 7 && h < 19/.test(file));
ok('export defaults to auto', /data-theme-mode="auto"/.test(file));

spawnSync(process.execPath, [CLI, 'config', 'set', 'ui.theme', 'night'], { cwd: PROJ, env: ENV, encoding: 'utf8' });
const pinned = spawnSync(process.execPath, [CLI, 'export', '--out', htmlOut], { cwd: PROJ, env: ENV, encoding: 'utf8' });
ok('export re-ran with config', pinned.status === 0, pinned.stderr || pinned.stdout);
const dark = fs.readFileSync(htmlOut, 'utf8');
ok('ui.theme pins the export', /data-theme-mode="night"/.test(dark) && /data-theme="night"/.test(dark));
ok('...and the no-flash script agrees', /var mode = saved === 'day' \|\| saved === 'night' \|\| saved === 'auto' \? saved : "night"/.test(dark), dark.match(/var mode = .*/)?.[0] || 'no mode line');

report();
