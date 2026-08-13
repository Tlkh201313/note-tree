/**
 * Drive the real `note-tree tree` server end to end: spawn the CLI exactly as a
 * user would, wait for the URL it prints, probe every route, prove SSE fires
 * when another process writes a note, then shut it down.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { ok, report, tmpdir, CLI, SRC, REPO } from './lib/harness.mjs';

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

/* ---------------------------------------------------------- interaction --- */
// Every one of these guards a bug that shipped in 0.1.0 and 0.1.1.
//
// `#empty` is `position:absolute; inset:0` — a full-stage overlay. Its id
// selector sets `display:grid`, which outranks the UA sheet's
// `[hidden] { display:none }`, so `el.hidden = true` did nothing and the
// overlay sat on top of the tree: "Nothing planted yet." printed over a tree
// full of leaves, and it swallowed every hover and click. One CSS bug, three
// symptoms, and no test in the suite could see any of them.
const css = fs.readFileSync(path.join(REPO, 'src', 'ui', 'web', 'app.css'), 'utf8');
ok('the hidden attribute outranks id rules', /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css));
ok('the empty overlay never eats pointer events', /#empty\s*\{[^}]*pointer-events:\s*none/.test(css));

// The leaf's colour is the only thing on the tree encoding data, and it hung
// off `.leaf > path:first-child`. Adding a stalk ahead of the blade made that
// selector match the stalk, and every leaf rendered black. Positional selectors
// break silently when a sibling appears; this one is now by name.
ok('leaf colour is not positional', !/\.leaf\s*>\s*path:first-child/.test(css) && /\.leaf\s+\.blade\s*\{[^}]*fill:\s*currentColor/.test(css));

const appJs = fs.readFileSync(path.join(REPO, 'src', 'ui', 'web', 'app.js'), 'utf8');
ok('the blade carries that class', /class:\s*'blade'/.test(appJs));
ok('the tooltip carries a calendar date, not just "2h ago"', /\$\{day\(leaf\.updated\)\}/.test(appJs));
ok('the panel shows desc, date and body', ['.desc', '.body', 'full(leaf.created)'].every((s) => appJs.includes(s)));

/* --------------------------------------------------------------- layout --- */
const { layout, groupSessions } = await import(`${SRC}/ui/tree.mjs`);
const NOW = Date.parse('2026-08-13T00:00:00.000Z');
const sample = Array.from({ length: 9 }, (_, i) => ({
  id: `id${i}`.padEnd(6, 'x'),
  title: `Note ${i}`,
  kind: ['gotcha', 'decision', 'convention'][i % 3],
  scope: 'project',
  session: `s${Math.floor(i / 3)}`,
  created: new Date(NOW - (9 - i) * 3600_000).toISOString(),
  archived: i === 8,
}));

const A = layout(sample, { now: NOW });
const B = layout(sample, { now: NOW });
// The documented core promise: a leaf that was on the left yesterday is on the
// left today. Nothing here may reach for Math.random().
ok('layout is deterministic', JSON.stringify(A) === JSON.stringify(B));
ok('layout draws every note', A.leaves.length === sample.length, `${A.leaves.length} of ${sample.length}`);
ok('archived counted apart', A.counts.archived === 1 && A.counts.live === 8, JSON.stringify(A.counts));
ok('one branch per session', A.branches.length === groupSessions(sample).length, `${A.branches.length}`);

const F = A.frame;
ok('frame stays on the canvas', F.x >= 0 && F.y >= 0 && F.x + F.w <= A.width + 0.01 && F.y + F.h <= A.height + 0.01, JSON.stringify(F));
ok('frame does not zoom past legibility', F.w >= 620, String(F.w));
// The whole point of cropping: a young tree should not float in empty canvas.
ok('frame crops a young tree', layout(sample.slice(0, 2), { now: NOW }).frame.w < A.width);
const live = A.leaves.filter((l) => !l.archived);
ok('every leaf is inside the frame', live.every((l) => l.x >= F.x && l.x <= F.x + F.w && l.y >= F.y && l.y <= F.y + F.h));
ok('roots stay on the canvas', A.roots.every((r) => r.y <= A.height + 0.01), JSON.stringify(A.roots.map((r) => r.y)));
ok('soil is a hint, not a third of the frame', (A.height - A.ground) / A.height < 0.22, String((A.height - A.ground) / A.height));
// Compared against the same note un-archived, not against its neighbours — a
// leaf further along the branch starts higher, so neighbours prove nothing.
const restored = layout(sample.map((n) => ({ ...n, archived: false })), { now: NOW });
const sameLeaf = (L) => L.leaves.find((l) => l.id === sample[8].id);
ok('archived leaves hang below where they grew', sameLeaf(A).y > sameLeaf(restored).y + 20, `${sameLeaf(A).y} vs ${sameLeaf(restored).y}`);
ok('archived leaves dim', sameLeaf(A).opacity < sameLeaf(restored).opacity);

// The plate's structure: branches in opposite pairs off shared nodes on a
// straight stem, with the apex left to the terminal shoot.
ok('branches pair off onto shared nodes', A.branches[0].y0 === A.branches[1].y0, `${A.branches[0].y0} vs ${A.branches[1].y0}`);
ok('a pair points opposite ways', A.branches[0].side === -A.branches[1].side);
ok('the stem is a straight axis', A.branches.every((b) => b.x0 === A.branches[0].x0));
ok('nothing overtops the apex', A.branches.every((b) => b.y1 > A.trunk.topY), `apex ${A.trunk.topY}, tips ${A.branches.map((b) => b.y1)}`);
ok('every leaf knows where it attaches', A.leaves.every((l) => Number.isFinite(l.stemX) && Number.isFinite(l.stemY)));
// Opposite pairs again, one level down: two leaves share a point on the branch
// and sit either side of it.
const firstBranchLeaves = A.leaves.filter((l) => l.session === A.branches[0].id);
ok('leaves pair along the branch', firstBranchLeaves.length < 2 || firstBranchLeaves[0].stemY === firstBranchLeaves[1].stemY);
ok('a pair sits either side of the stem', firstBranchLeaves.length < 2 || Math.sign(firstBranchLeaves[0].x - firstBranchLeaves[0].stemX) === -Math.sign(firstBranchLeaves[1].x - firstBranchLeaves[1].stemX));

const empty = layout([], { now: NOW });
ok('an empty tree still frames cleanly', empty.frame.w > 0 && empty.frame.h > 0 && empty.counts.notes === 0, JSON.stringify(empty.frame));

report();
