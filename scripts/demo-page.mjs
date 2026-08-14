/**
 * Render docs/index.html — the live, clickable demo published to GitHub Pages.
 *
 * It is the *real* export (`src/ui/export.mjs`), seeded with the same sample
 * corpus as `note-tree demo`, so the page people click is the actual product,
 * not a mock-up: hover a leaf, click for the note, replay the growth, flip the
 * theme. Only `live: false` differs from a running server — no SSE, no writes.
 *
 *   node scripts/demo-page.mjs               # docs/index.html
 *   node scripts/demo-page.mjs --notes 48    # a fuller canopy
 *
 * `now` is pinned, so re-running produces a byte-identical file rather than a
 * diff full of shifted ages — the same discipline as scripts/hero.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const COUNT = Math.max(1, Math.min(Number(arg('notes', 40)), 400));
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'index.html')));

// Pinned so the committed page is reproducible. The corpus is laid out ending
// at `now`, so the newest leaves sit at "today" and the oldest ~six weeks back.
const NOW = Date.parse('2026-08-13T12:00:00.000Z');

// A throwaway store: the demo must never render anyone's actual memory. Redirect
// HOME/USERPROFILE too, or an adapter resolving ~/.config touches the real one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-demo-page-'));
process.env.NOTE_TREE_HOME = tmp;
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const SRC = pathToFileURL(path.join(REPO, 'src')).href;
const { openContext } = await import(`${SRC}/context.mjs`);
const { buildExport } = await import(`${SRC}/ui/export.mjs`);
const { sampleNotes } = await import(`${SRC}/cli/cmd/view.mjs`);

const ctx = openContext({ cwd: path.join(tmp, 'orchard-api'), slug: 'orchard-api', agent: 'demo', withProject: true });
ctx.store.ensure();
for (const note of sampleNotes(COUNT, NOW)) {
  try {
    ctx.store.write(note, { project: ctx.slug }, { force: true });
  } catch {
    /* one unusable sample shouldn't cost us the demo */
  }
}
ctx.reindex();

const SITE = 'https://tlkh201313.github.io/note-tree/';

// The demo stands in a real-sized repo, not the empty temp dir it's built in, so
// its roots read the way a working project's do. (A live tree walks its own cwd.)
const built = buildExport(ctx, {
  scope: 'all',
  bodies: true,
  now: NOW,
  projectFiles: 640,
  // The tab of an export names your project. This one is a landing page, so it
  // says what the thing is — it's read by people who have never heard of it.
  title: 'note-tree — a live tree of an agent’s memory',
  // The only page note-tree renders that *should* be indexed: it is sample data,
  // and being found is the point. Everything else stays `noindex` by default.
  meta: {
    description:
      'Token-lean shared memory for coding agents. Every note is a leaf — hover one, ' +
      'click it, replay the growth. The real export, not a mock-up.',
    url: SITE,
    // No og:image yet: the hero is an SVG, and card unfurlers refuse SVG. See
    // docs/media.md for how to add a PNG without committing one to the repo.
  },
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, built.html);
// Tell GitHub Pages not to run the file through Jekyll — nothing here needs it,
// and Jekyll silently drops paths that start with an underscore.
fs.writeFileSync(path.join(path.dirname(OUT), '.nojekyll'), '');
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  `${path.relative(REPO, OUT)} — ${built.counts.project} project + ${built.counts.global} global notes, ` +
    `${(built.bytes / 1024).toFixed(0)} KB, self-contained`,
);
