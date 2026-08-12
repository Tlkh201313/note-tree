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
import { KIND_LEGEND } from '../theme.mjs';
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
      `<i class="dot" style="background:${esc(k.hex)}"></i>${esc(k.kind)}</span>`,
  ).join('');

  const tabs = (data.scopes || [])
    .map(
      (s) =>
        `<button class="tab" data-scope="${esc(s.id)}" aria-selected="${String(s.id === data.scope)}">` +
        `${esc(s.label)}${s.count != null ? ` <span class="stat">${esc(s.count)}</span>` : ''}</button>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en" data-theme="night" data-view="tree" data-motion="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${asset('app.css')}</style>
</head>
<body>
<header>
  <span class="brand"><span class="leaf">&#10086;</span> note-tree <small>${esc(data.project || 'memory')}</small></span>
  <span class="stat"><b id="count">0</b> notes &middot; <b id="sessions">0</b> sessions &middot; <b id="stage-name">seed</b></span>
  <nav class="tabs" aria-label="scope">${tabs}</nav>
  <button id="view-toggle" aria-pressed="false" title="Plain list, for screen readers and quick scanning">list view</button>
  <button id="theme-toggle" title="Day / night">&#9681;</button>
  <span class="live" id="live" data-state="${data.live ? 'on' : 'off'}">${data.live ? 'live' : 'static'}</span>
</header>

<main>
  <div id="stage">
    <svg id="tree" role="img" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMax meet">
      <defs>
        <linearGradient id="bark" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#5c4630"/>
          <stop offset="0.42" stop-color="#8b6f47"/>
          <stop offset="1" stop-color="#4a3826"/>
        </linearGradient>
      </defs>
      <g id="l-roots"></g>
      <g id="l-trunk"></g>
      <g id="l-branches"></g>
      <g id="l-leaves"></g>
    </svg>
    <div id="empty" hidden>
      <div>Nothing planted yet.</div>
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
  </div>
</aside>

<div id="legend">${legend}</div>

<script>
const DATA = ${jsonScript(data)};
const LAYOUT = ${jsonScript(initial)};
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
