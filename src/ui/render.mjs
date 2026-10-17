/**
 * The page, assembled.
 *
 * One function builds the whole document, and both the live server and the
 * static export call it. That's deliberate: a demo you can click is the single
 * best thing this project can put in front of someone, and it stays honest only
 * if the exported file *is* the app, not a screenshot of it.
 *
 * Everything is inlined — CSS, script, data. The result opens from a USB stick
 * with the network off.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_LEGEND, kindCssVars, STAGES } from '../theme.mjs';
import { layout } from './tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const asset = (name) => fs.readFileSync(path.join(HERE, 'web', name), 'utf8');

/**
 * JSON that is safe to drop inside a `<script>` element.
 *
 * `</script>` in a note title would end the block early, and JSON permits raw
 * U+2028/U+2029 where older JavaScript parsers do not.
 */
function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * The tab icon: one leaf, the same two arcs and midrib `drawLeaf` builds, at the
 * kind colour the brand glyph already wears.
 *
 * Inline as a data URI rather than a file, because a favicon is the one asset a
 * browser fetches without being asked — a `<link>` to anything else would put a
 * network request into a page whose whole promise is that it opens from a USB
 * stick with the wifi off. `#` must be percent-encoded or it truncates the URI.
 */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<path d="M16 4C26 12 22.4 23.6 16 28 9.6 23.6 6 12 16 4Z" fill="#4b8a63"/>' +
    '<path d="M16 6.5V26" stroke="#2f5f43" stroke-width="1.4" opacity=".55"/>' +
    '</svg>',
)}`;

/**
 * The `<head>` metadata.
 *
 * Default is `noindex`, and that default matters: an export is somebody's actual
 * memory, and the common case is a file dropped on a shared drive or an internal
 * host. It must never turn up in a search result because we assumed otherwise.
 *
 * `meta` opts a page *out* of that — only the published demo passes it, where the
 * page is sample data and being findable is the entire point. It also carries the
 * description and card tags, so a link pasted into Slack or a post unfurls with a
 * headline instead of a bare URL.
 *
 * @param meta.description  one line, used for search results and link previews
 * @param meta.url          canonical absolute URL
 * @param meta.image        absolute URL of a card image (PNG or JPEG — most
 *                          unfurlers refuse SVG, so an SVG here would render as
 *                          no card at all rather than a vector one)
 * @param meta.imageAlt     alt text for that image
 */
function headMeta(meta, title) {
  if (!meta) return '<meta name="robots" content="noindex">';

  const { description = '', url = '', image = '', imageAlt = '' } = meta;
  const tags = [];
  if (description) tags.push(`<meta name="description" content="${esc(description)}">`);
  if (url) tags.push(`<link rel="canonical" href="${esc(url)}">`);
  tags.push(`<meta property="og:type" content="website">`);
  tags.push(`<meta property="og:site_name" content="note-tree">`);
  tags.push(`<meta property="og:title" content="${esc(title)}">`);
  if (description) tags.push(`<meta property="og:description" content="${esc(description)}">`);
  if (url) tags.push(`<meta property="og:url" content="${esc(url)}">`);
  if (image) {
    tags.push(`<meta property="og:image" content="${esc(image)}">`);
    if (imageAlt) tags.push(`<meta property="og:image:alt" content="${esc(imageAlt)}">`);
  }
  // A card with no image is `summary`; claiming `summary_large_image` without one
  // gets the whole card dropped by some unfurlers rather than downgraded.
  tags.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
  tags.push(`<meta name="twitter:title" content="${esc(title)}">`);
  if (description) tags.push(`<meta name="twitter:description" content="${esc(description)}">`);
  if (image) tags.push(`<meta name="twitter:image" content="${esc(image)}">`);
  return tags.join('\n');
}

/**
 * @param opts.data    `{ live, scope, scopes, project, layouts? }`
 * @param opts.layout  the layout to render first
 * @param opts.meta    public-page metadata; omitted means `noindex` (see `headMeta`)
 */
export function renderPage({ data, layout: initial, title = 'note-tree', meta = null }) {
  const legend = KIND_LEGEND.map(
    (k) =>
      `<span data-kind="${esc(k.kind)}" title="mute ${esc(k.kind)} leaves">` +
      `<i class="dot" data-kind="${esc(k.kind)}"></i>${esc(k.kind)}</span>`,
  ).join('');

  const kinds = kindCssVars();

  // `auto` is the honest default, but someone who works nights and wants the
  // dark tree at noon shouldn't have to click every time they open a fresh
  // export. Config sets the starting point; the toggle overrides it per browser.
  const pref = ['auto', 'day', 'night'].includes(data.theme) ? data.theme : 'auto';

  const tabs = (data.scopes || [])
    .map(
      (s) =>
        `<button class="tab" data-scope="${esc(s.id)}" aria-selected="${String(s.id === data.scope)}">` +
        `${esc(s.label)}${s.count != null ? ` <span class="stat">${esc(s.count)}</span>` : ''}</button>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en" data-theme="${pref === 'night' ? 'night' : 'day'}" data-theme-mode="${pref}" data-view="tree" data-motion="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${headMeta(meta, title)}
<title>${esc(title)}</title>
<link rel="icon" href="${FAVICON}">
<style>
:root { ${kinds.day} }
:root[data-theme='night'] { ${kinds.night} }
${asset('app.css')}</style>
<script>
/* Before first paint, or the page flashes the wrong theme on every load.
 * Day and night come from the clock on whatever machine is looking at the
 * page — no geolocation, no setting to find, right by default in either half
 * of the world. An explicit choice, once made, wins until it's cleared. */
(function () {
  var r = document.documentElement, saved = null;
  try { saved = localStorage.getItem('note-tree:theme'); } catch (e) {}
  var mode = saved === 'day' || saved === 'night' || saved === 'auto' ? saved : ${jsonScript(pref)};
  var h = new Date().getHours();
  r.dataset.themeMode = mode;
  r.dataset.theme = mode === 'auto' ? (h >= 7 && h < 19 ? 'day' : 'night') : mode;
})();
</script>
</head>
<body>
<header>
  <span class="brand"><span class="leaf">&#10086;</span> note-tree <small>${esc(data.project || 'memory')}</small></span>
  <span class="stat">
    <b id="count">0</b> notes<span class="sep">&middot;</span><b id="sessions">0</b> <span id="sessions-label">sessions</span><span class="sep">&middot;</span><span id="stage-name">seed</span>${
      data.seed ? `<span class="sep">&middot;</span><b id="seed-cost" title="What the next session receives from this tree">~${esc(data.seed.tokens)} tokens/session</b>` : ''
    }
  </span>
  <span class="spacer"></span>
  <nav class="tabs" aria-label="scope">${tabs}</nav>
  <input id="search" type="search" placeholder="Search  /" aria-label="Filter notes" autocomplete="off" spellcheck="false">
  <button id="replay" title="Watch this tree grow, note by note, in the order you saved them">replay</button>
  <button id="view-toggle" aria-pressed="false" title="Plain list, for screen readers and quick scanning">list</button>
  <button id="theme-toggle" title="Theme: follows the clock">&#9681;</button>
  <span class="live" id="live" data-state="${data.live ? 'on' : 'off'}">${data.live ? 'live' : 'static'}</span>
</header>

<main>
  <div id="stage">
    <svg id="tree" role="img" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMax meet">
      <defs>
        <!-- The replay grows the trunk by raising this window over it. A clip is
             the only way to reveal a filled path from one end without touching
             the path data the rest of the page depends on. -->
        <clipPath id="grow" clipPathUnits="userSpaceOnUse">
          <rect id="grow-rect" x="-4000" y="-4000" width="8000" height="12000"></rect>
        </clipPath>
      </defs>
      <g id="l-roots"></g>
      <g id="l-trunk"></g>
      <!-- Branches and leaves sway together, as one crown. They used to sway
           separately, at different speeds, and the leaves slid off the ends of
           their own branches. -->
      <g id="l-crown" class="sway">
        <g id="l-branches"></g>
        <g id="l-leaves"></g>
      </g>
    </svg>
    <!-- No hidden attribute here: Chromium renders [hidden] as display:none
         !important, which a normal author rule can't override, so it would
         defeat the #stage[data-empty] toggle below. The default #empty rule
         (display:none) is what keeps this gone until the stage is empty — a
         state attribute we own, never out-specified by the UA sheet. -->
    <div id="empty">
      <svg class="seedling" viewBox="0 0 120 116" width="126" height="122" aria-hidden="true">
        <line class="soil" x1="16" y1="94" x2="104" y2="94"/>
        <path class="mound" d="M43 94 Q60 85 77 94"/>
        <path class="stem" d="M60 95 C60 76 60 62 60 44"/>
        <path class="twig" d="M60 68 C53 64 48 58 45 52"/>
        <path class="twig" d="M60 60 C67 56 72 50 75 44"/>
        <g class="leaf a" transform="translate(41 49) rotate(-37)"><ellipse rx="7.5" ry="12"/></g>
        <g class="leaf b" transform="translate(79 41) rotate(33)"><ellipse rx="7.5" ry="12"/></g>
        <circle class="bud" cx="60" cy="43" r="3"/>
      </svg>
      <div class="big">Nothing planted yet.</div>
      <div class="hint">Save the first thing worth remembering — the tree grows from here.</div>
      <div><code>note-tree add "what you just learned"</code></div>
    </div>
  </div>
  <div id="list" aria-label="notes, list view"></div>
</main>

<div id="tip" role="tooltip"><span class="t"></span><span class="d"></span></div>

<aside id="sidebar" data-open="false" aria-label="note details">
  <button class="close" title="Close (Esc)" aria-label="Close">&times;</button>
  <header>
    <span class="kindline"><i class="dot"></i><span class="kind"></span></span>
    <h2></h2>
    <p class="desc"></p>
  </header>
  <div class="meta"></div>
  <div class="body"></div>
  <div class="actions">
    <button data-action="pin" hidden>Pin</button>
    <button data-action="promote" hidden>Promote</button>
    <button data-action="archive" hidden>Archive</button>
    <button class="grow" data-copy title="Copy this note as Markdown, to paste into an agent">Copy</button>
  </div>
</aside>

<div id="legend">${legend}</div>

<div id="replay-bar" role="status">
  <span class="say"><b id="replay-stage">seed</b> <span id="replay-count">0 notes</span></span>
  <span class="track"><span class="fill" id="replay-fill"></span></span>
  <button id="replay-stop" title="Stop the replay (Esc)">skip</button>
</div>

<script>
const DATA = ${jsonScript(data)};
const LAYOUT = ${jsonScript(initial)};
const STAGES = ${jsonScript(STAGES)};
</script>
<script>${asset('app.js')}</script>
</body>
</html>
`;
}

/**
 * Scope tabs the page should offer.
 *
 * A global-only context (no project) gets one tab and no chooser to speak of —
 * showing an empty "project" tree there would just be a puzzle.
 */
export function scopeTabs({ project, global, slug }) {
  const tabs = [];
  if (slug) tabs.push({ id: 'project', label: slug.replace(/-[a-z0-9]{6}$/, ''), count: project });
  tabs.push({ id: 'global', label: 'global', count: global });
  if (slug) tabs.push({ id: 'all', label: 'both', count: project + global });
  return tabs;
}

/** Layout for one scope, straight from index entries. */
export function layoutFor(entries, opts) {
  return layout(entries, opts);
}
