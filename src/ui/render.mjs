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
 * @param opts.data    `{ live, scope, scopes, project, layouts? }`
 * @param opts.layout  the layout to render first
 */
export function renderPage({ data, layout: initial, title = 'note-tree' }) {
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
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
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
    <b id="count">0</b> notes<span class="sep">&middot;</span><b id="sessions">0</b> sessions<span class="sep">&middot;</span><span id="stage-name">seed</span>${
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
    <div id="empty" hidden>
      <div class="big">Nothing planted yet.</div>
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
