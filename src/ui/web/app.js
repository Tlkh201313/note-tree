/**
 * The tree page.
 *
 * Vanilla, no build step, no framework, and it must work identically whether
 * the page came from the live server or from a single exported HTML file. The
 * only difference between the two is `DATA.live` — when it's false there is no
 * SSE stream and no write actions, and every code path below has to be fine
 * with that.
 *
 * `DATA` and `LAYOUT` are injected as JSON above this script.
 */

(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const root = document.documentElement;
  const byId = new Map();
  const branchById = new Map();
  // Bodies are fetched once and kept here rather than on the leaf object,
  // because every live update replaces every leaf object in `LAYOUT`.
  const bodyCache = new Map();
  let selected = null;
  let hidden = new Set();
  let query = '';

  /* ------------------------------------------------------------- render -- */

  const svg = document.getElementById('tree');
  const layers = {
    branches: document.getElementById('l-branches'),
    leaves: document.getElementById('l-leaves'),
  };

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  /** Two decimals is under a screen pixel, and keeps the path data short. */
  const fx = (n) => Math.round(n * 100) / 100;

  function drawLeaf(leaf, { sprout = false } = {}) {
    const g = el('g', { class: 'leaf' + (sprout ? ' sprout' : ''), transform: `translate(${leaf.x} ${leaf.y}) rotate(${leaf.angle})` }, layers.leaves);
    g.setAttribute('data-id', leaf.id);
    g.setAttribute('data-kind', leaf.kind);
    g.setAttribute('data-pinned', String(leaf.pinned));
    g.setAttribute('data-archived', String(Boolean(leaf.archived)));
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${leaf.kind}: ${leaf.title}, ${when(leaf.updated)}`);
    g.style.opacity = leaf.opacity;

    // A leaf, not a circle: two arcs meeting at a point, with a midrib. The
    // fill comes from CSS (`currentColor` per kind) rather than the payload, so
    // switching day/night recolours the whole tree without redrawing it.
    const r = leaf.r;

    // The stalk that joins it to its branch. The group is already translated
    // and rotated onto the leaf, so the attachment point has to come back the
    // other way — rotate the offset by -angle to land in the leaf's own frame.
    if (Number.isFinite(leaf.stemX)) {
      const a = (leaf.angle * Math.PI) / 180;
      const dx = leaf.stemX - leaf.x;
      const dy = leaf.stemY - leaf.y;
      const lx = dx * Math.cos(a) + dy * Math.sin(a);
      const ly = -dx * Math.sin(a) + dy * Math.cos(a);
      el('path', { class: 'stalk', d: `M ${fx(lx)} ${fx(ly)} L 0 ${fx(r * 1.35)}`, 'stroke-width': Math.max(0.6, r * 0.16) }, g);
    }

    el('path', {
      class: 'blade',
      d: `M 0 ${-r * 1.5} C ${r * 1.25} ${-r * 0.5}, ${r * 0.8} ${r * 0.95}, 0 ${r * 1.5} C ${-r * 0.8} ${r * 0.95}, ${-r * 1.25} ${-r * 0.5}, 0 ${-r * 1.5} Z`,
    }, g);
    el('path', { class: 'vein', d: `M 0 ${-r * 1.15} L 0 ${r * 1.2}`, 'stroke-width': Math.max(0.45, r * 0.1) }, g);
    if (leaf.pinned) el('circle', { class: 'pin', r: Math.max(1.1, r * 0.34), cy: -r * 0.1 }, g);
    el('circle', { class: 'ring', r: r * 2.1, 'stroke-width': 1.1 }, g);

    byId.set(leaf.id, { leaf, node: g });
    return g;
  }

  function render() {
    const L = LAYOUT;
    const F = L.frame || { x: 0, y: 0, w: L.width, h: L.height };
    svg.setAttribute('viewBox', `${F.x} ${F.y} ${F.w} ${F.h}`);
    svg.setAttribute('aria-label', `${L.counts.live} notes across ${L.counts.sessions} sessions, a ${L.stage} tree`);

    document.getElementById('l-roots').replaceChildren();
    for (const r of L.roots) el('path', { class: 'root', d: r.d, 'stroke-width': r.width }, document.getElementById('l-roots'));

    document.getElementById('l-trunk').replaceChildren();
    el('path', { class: 'trunk', d: L.trunk.path }, document.getElementById('l-trunk'));
    // One hairline for the ground. The old soil band drew the eye downward,
    // away from the thing the page is about.
    el('line', { class: 'ground', x1: 0, y1: L.ground, x2: L.width, y2: L.ground }, document.getElementById('l-trunk'));

    layers.branches.replaceChildren();
    branchById.clear();
    for (const b of L.branches) {
      const path = el('path', { class: 'branch', d: b.d, 'stroke-width': b.width, 'data-branch': b.id }, layers.branches);
      branchById.set(b.id, path);
    }

    layers.leaves.replaceChildren();
    byId.clear();
    for (const leaf of L.leaves) drawLeaf(leaf);

    document.getElementById('count').textContent = L.counts.live;
    document.getElementById('stage-name').textContent = L.stage;
    document.getElementById('sessions').textContent = L.counts.sessions;
    // Drives `#stage[data-empty]` rather than the `hidden` attribute. `#empty`
    // is a full-stage overlay, and `hidden` is only a UA-stylesheet default —
    // any id rule setting `display` silently beats it, which once left this
    // card sitting on top of a full tree, swallowing every click. A state
    // attribute we own can't be out-specified by accident.
    document.getElementById('stage').dataset.empty = String(L.counts.notes === 0);
    renderList();
    applyFilter();
  }

  function renderList() {
    const wrap = document.getElementById('list');
    const groups = new Map();
    for (const leaf of LAYOUT.leaves) {
      const day = new Date(leaf.created).toISOString().slice(0, 10);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(leaf);
    }
    const parts = [];
    for (const [day, items] of [...groups].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
      parts.push(`<h3>${day}</h3><ol>`);
      for (const leaf of items) {
        parts.push(
          `<li tabindex="0" data-id="${esc(leaf.id)}">` +
            `<span class="dot" data-kind="${esc(leaf.kind)}"></span>` +
            `<span class="title">${esc(leaf.title)}</span>` +
            `<span class="when">${esc(leaf.kind)} · ${esc(when(leaf.updated))}</span></li>`,
        );
      }
      parts.push('</ol>');
    }
    wrap.innerHTML = parts.join('') || '<p>No notes yet.</p>';
  }

  /* -------------------------------------------------------------- filter -- */

  // One predicate drives both views: muted leaves on the tree, hidden rows in
  // the list. Kind toggles from the legend and the search box compose.
  function matches(leaf) {
    if (hidden.has(leaf.kind)) return false;
    if (!query) return true;
    const hay = `${leaf.title} ${leaf.desc || ''} ${leaf.kind} ${(leaf.tags || []).join(' ')}`.toLowerCase();
    return query.split(/\s+/).every((word) => hay.includes(word));
  }

  function applyFilter() {
    let shown = 0;
    for (const [, { leaf, node }] of byId) {
      const on = matches(leaf);
      node.setAttribute('data-dim', String(!on));
      if (on) shown += 1;
    }
    for (const li of document.querySelectorAll('#list li[data-id]')) {
      const leaf = LAYOUT.leaves.find((l) => l.id === li.dataset.id);
      li.setAttribute('data-dim', String(!(leaf && matches(leaf))));
    }
    for (const h of document.querySelectorAll('#list h3')) {
      const list = h.nextElementSibling;
      h.hidden = !list || ![...list.children].some((li) => li.dataset.dim !== 'true');
    }
    document.getElementById('count').textContent = query || hidden.size ? `${shown}/${LAYOUT.counts.live}` : LAYOUT.counts.live;
  }

  /* -------------------------------------------------------- interaction -- */

  const tip = document.getElementById('tip');
  function showTip(leaf, x, y) {
    tip.querySelector('.t').textContent = leaf.title;
    // Name and date, which is the whole job of a tooltip here. Both forms of
    // the date: the calendar one you can match against a commit, and the
    // relative one that answers "is this stale?" without arithmetic.
    tip.querySelector('.d').textContent =
      `${leaf.kind} · ${day(leaf.updated)} · ${when(leaf.updated)}` +
      `${leaf.pinned ? ' · pinned' : ''}${leaf.archived ? ' · archived' : ''}`;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.dataset.show = 'true';
  }
  const hideTip = () => (tip.dataset.show = 'false');

  function leafFrom(target) {
    const node = target.closest?.('[data-id]');
    return node ? byId.get(node.dataset.id) || { leaf: LAYOUT.leaves.find((l) => l.id === node.dataset.id), node } : null;
  }

  svg.addEventListener('pointermove', (e) => {
    const hit = leafFrom(e.target);
    if (!hit) return hideTip();
    const box = hit.node.getBoundingClientRect();
    showTip(hit.leaf, box.left + box.width / 2, box.top);
  });
  svg.addEventListener('pointerleave', hideTip);
  svg.addEventListener('focusin', (e) => {
    const hit = leafFrom(e.target);
    if (!hit) return;
    const box = hit.node.getBoundingClientRect();
    showTip(hit.leaf, box.left + box.width / 2, box.top);
  });
  svg.addEventListener('focusout', hideTip);

  document.addEventListener('click', (e) => {
    const hit = leafFrom(e.target);
    if (hit) open(hit.leaf.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return replaying ? finishReplay?.() : close();
    // `/` jumps to the filter, the one shortcut worth having on a page whose
    // whole job is finding the note you half-remember.
    if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
      e.preventDefault();
      return document.getElementById('search').focus();
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hit = leafFrom(e.target);
    if (hit) {
      e.preventDefault();
      open(hit.leaf.id);
    }
  });

  /* -------------------------------------------------------------- panel -- */

  const panel = document.getElementById('sidebar');
  const $body = panel.querySelector('.body');
  const $desc = panel.querySelector('.desc');

  /** Everything the panel shows for one leaf. Called on open *and* on refresh. */
  function paint(leaf) {
    panel.querySelector('h2').textContent = leaf.title;
    panel.querySelector('.dot').dataset.kind = leaf.kind;
    panel.querySelector('.kind').textContent =
      leaf.kind + (leaf.pinned ? ' · pinned' : '') + (leaf.archived ? ' · archived' : '');
    // The description is written in the same Markdown as the body, so `note_write`
    // in a note shouldn't read as a line with backticks stuck to it.
    $desc.innerHTML = inline(leaf.desc || '');
    $desc.hidden = !leaf.desc;
    panel.querySelector('.meta').innerHTML =
      [
        `<span>${esc(leaf.scope)}</span>`,
        leaf.agent ? `<span> · via ${esc(leaf.agent)}</span>` : '',
        `<span> · ${esc(full(leaf.created))}</span>`,
        leaf.reads ? `<span> · ${leaf.reads} recall${leaf.reads === 1 ? '' : 's'}</span>` : '',
        '<br>',
        (leaf.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join(''),
      ].join('');

    // The buttons toggle on the server, so they have to say which way they'll
    // go. "Pin" on an already-pinned note is a lie the first click exposes.
    const label = { pin: leaf.pinned ? 'Unpin' : 'Pin', archive: leaf.archived ? 'Restore' : 'Archive', promote: leaf.scope === 'global' ? 'Demote' : 'Promote' };
    for (const b of panel.querySelectorAll('.actions button[data-action]')) {
      b.hidden = !DATA.live;
      b.textContent = label[b.dataset.action] || b.textContent;
    }

    const cached = bodyCache.get(leaf.id);
    if (cached !== undefined) writeBody(cached);
    else if (!DATA.live) writeBody('', '(body not included in this export)');
    else writeBody('', 'Loading…');
  }

  /** Markdown in, prose out. `note` is a plain-text fallback for empty bodies. */
  function writeBody(text, note) {
    if (!text) {
      $body.innerHTML = `<p class="muted">${esc(note || 'No body — the description above is the whole note.')}</p>`;
      return;
    }
    $body.innerHTML = markdown(text);
  }

  async function open(id) {
    const entry = byId.get(id) || { leaf: LAYOUT.leaves.find((l) => l.id === id) };
    if (!entry?.leaf) return;
    const leaf = entry.leaf;

    if (selected) selected.node?.removeAttribute('data-selected');
    selected = byId.get(id) || { leaf, node: null };
    selected.node?.setAttribute('data-selected', 'true');

    paint(leaf);
    panel.dataset.open = 'true';
    // Restart the content entrance, so opening a second note from an already
    // open panel still reads as "this is a different note".
    panel.classList.remove('fresh');
    void panel.offsetWidth;
    panel.classList.add('fresh');
    panel.querySelector('.close').focus({ preventScroll: true });

    // Bodies aren't in the payload when the page is live — that's what keeps
    // the initial load small. Fetch on demand, once, then keep it.
    if (bodyCache.has(id) || !DATA.live) return;
    try {
      const res = await fetch(`./api/note/${encodeURIComponent(id)}`);
      const note = await res.json();
      bodyCache.set(id, note.body || '');
      leaf.desc = note.desc || leaf.desc;
      if (panel.dataset.open === 'true' && selected?.leaf?.id === id) {
        writeBody(bodyCache.get(id));
        $desc.innerHTML = inline(leaf.desc || '');
        $desc.hidden = !leaf.desc;
      }
    } catch {
      if (selected?.leaf?.id === id) writeBody('', 'Could not load this note. It may have been removed.');
    }
  }

  /**
   * Re-attach the panel to its leaf after a redraw.
   *
   * `render()` throws away every node, so the selection is holding a corpse:
   * without this, pinning a note dropped the highlight and left the panel
   * showing the note as it was before the change.
   */
  function resync() {
    if (panel.dataset.open !== 'true' || !selected) return;
    const id = selected.leaf.id;
    const entry = byId.get(id);
    if (!entry) return close();
    selected = entry;
    entry.node.setAttribute('data-selected', 'true');
    paint(entry.leaf);
  }

  function close() {
    panel.dataset.open = 'false';
    panel.classList.remove('fresh');
    if (selected) selected.node?.removeAttribute('data-selected');
    selected = null;
  }
  panel.querySelector('.close').addEventListener('click', close);

  // Copy the note the way an agent should receive it: frontmatter-ish header,
  // then the body. Pasting a leaf into another tool shouldn't lose its kind.
  panel.querySelector('[data-copy]').addEventListener('click', async (e) => {
    if (!selected) return;
    const leaf = selected.leaf;
    const text = [
      `${leaf.title}`,
      `${leaf.kind} · ${leaf.scope} · ${full(leaf.created)}`,
      (leaf.tags || []).length ? (leaf.tags || []).map((t) => `#${t}`).join(' ') : '',
      '',
      bodyCache.get(leaf.id) || leaf.desc || '',
    ]
      .filter((line, i) => line !== '' || i === 3)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const btn = e.target;
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1400);
    } catch {
      /* clipboard denied — nothing useful to say, and nothing broken */
    }
  });

  panel.querySelector('.actions').addEventListener('click', async (e) => {
    const action = e.target.closest('button[data-action]')?.dataset.action;
    if (!action || !selected) return;
    const id = selected.leaf.id;
    try {
      await fetch('./api/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
    } catch {
      /* the SSE refresh below is the source of truth either way */
    }
  });

  /* --------------------------------------------------------------- live -- */

  function connect() {
    if (!DATA.live || typeof EventSource === 'undefined') {
      document.getElementById('live').dataset.state = 'off';
      document.getElementById('live').textContent = 'static';
      return;
    }
    const es = new EventSource('./events');
    es.addEventListener('note', async (e) => {
      const ev = JSON.parse(e.data);
      // A replay is a story with an ending; don't rewrite it halfway through.
      if (replaying) return;
      if (ev.id) bodyCache.delete(ev.id);
      const fresh = await (await fetch('./api/layout?scope=' + encodeURIComponent(DATA.scope))).json();
      const known = new Set(LAYOUT.leaves.map((l) => l.id));
      Object.assign(LAYOUT, fresh);
      render();
      resync();
      // Only a leaf that wasn't on the tree a moment ago sprouts. Pinning or
      // archiving an existing note is a change, not a birth — replaying the
      // animation there made the leaf look like it had vanished.
      const born = LAYOUT.leaves.find((l) => !known.has(l.id));
      const node = born && byId.get(born.id)?.node;
      if (node) {
        node.classList.add('sprout');
        node.scrollIntoView({ block: 'center', behavior: root.dataset.motion === 'off' ? 'auto' : 'smooth' });
      }
    });
    es.onerror = () => {
      document.getElementById('live').dataset.state = 'off';
    };
  }

  /* -------------------------------------------------------------- replay -- */

  /**
   * The tree, grown again from a seed in the order the notes were written.
   *
   * It reuses the geometry that's already on screen and only touches four
   * things: stroke dashes on the roots and branches, a clip window over the
   * trunk, each leaf's `scale`, and the viewBox as a camera. So the last frame
   * of the replay *is* the tree you were looking at — nothing to re-render, and
   * nothing that can drift out of sync with the real layout.
   */
  let replaying = false;
  let finishReplay = null;

  const bar = {
    fill: document.getElementById('replay-fill'),
    stage: document.getElementById('replay-stage'),
    count: document.getElementById('replay-count'),
  };

  const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - (1 - t) ** 3;
  const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

  function stageAt(n) {
    let name = STAGES[0].name;
    for (const s of STAGES) if (n >= s.at) name = s.name;
    return name;
  }

  /** Dash a stroked path so it can draw itself. Returns a setter for 0..1. */
  function dashable(path) {
    const len = path.getTotalLength() || 1;
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    return (p) => {
      path.style.strokeDashoffset = `${len * (1 - p)}`;
    };
  }

  function startReplay() {
    const L = LAYOUT;
    if (replaying || !L.leaves.length) return;
    replaying = true;
    root.dataset.replay = 'on';
    root.dataset.view = 'tree';
    close();

    const F = L.frame || { x: 0, y: 0, w: L.width, h: L.height };
    const trunk = document.querySelector('#l-trunk .trunk');
    const ground = document.querySelector('#l-trunk .ground');
    const rect = document.getElementById('grow-rect');
    const rootPaths = [...document.querySelectorAll('#l-roots .root')].map(dashable);

    // Chronological — the whole point. Ties break on id so the order is stable.
    const order = [...L.leaves].sort(
      (a, b) => (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0) || (a.id < b.id ? -1 : 1),
    );
    const n = order.length;
    // Unhurried on purpose. The first cut ran three times this fast and read as
    // things being flung onto the screen rather than a plant growing.
    const total = Math.min(24_000, Math.max(7000, 2600 + n * 520));

    // Each branch is drawn just before the first leaf that hangs on it.
    const leafAt = order.map((leaf, i) => ({ leaf, node: byId.get(leaf.id)?.node, start: 0.26 + (i / n) * 0.66 }));
    const branchStart = new Map();
    for (const { leaf, start } of leafAt) {
      if (!branchStart.has(leaf.branch)) branchStart.set(leaf.branch, Math.max(0.12, start - 0.16));
    }
    const branches = [...branchById].map(([id, path]) => ({ set: dashable(path), start: branchStart.get(id) ?? 0.12 }));

    for (const { node } of leafAt) if (node) node.style.scale = '0';
    if (trunk) trunk.style.clipPath = 'url(#grow)';
    if (ground) ground.style.opacity = '0';

    // Camera: a tight box on the seed, pulling back to the finished frame.
    const seed = { w: F.w * 0.2, h: F.h * 0.2 };
    const from = { x: L.width / 2 - seed.w / 2, y: L.ground - seed.h * 0.66, w: seed.w, h: seed.h };

    const buried = L.height - L.ground; // the trunk's base, already below ground
    const reach = L.ground - F.y + 14;

    let raf = 0;
    const t0 = performance.now();

    const step = (now) => {
      const p = clamp01((now - t0) / total);

      // Every window is wide and every curve is eased at both ends: nothing
      // here should ever look like it was thrown into place.
      for (const set of rootPaths) set(easeInOut(clamp01(p / 0.16)));
      if (ground) ground.style.opacity = `${clamp01((p - 0.03) / 0.09)}`;
      if (rect) {
        const h = buried + easeInOut(clamp01((p - 0.04) / 0.4)) * reach;
        rect.setAttribute('y', `${L.height - h}`);
        rect.setAttribute('height', `${h}`);
      }
      for (const b of branches) b.set(easeInOut(clamp01((p - b.start) / 0.2)));

      let grown = 0;
      for (const { node, start } of leafAt) {
        const q = clamp01((p - start) / 0.15);
        if (q > 0.5) grown += 1;
        // No overshoot. A leaf opens; it does not bounce.
        if (node) node.style.scale = `${easeInOut(q)}`;
      }

      // Pull back a little ahead of the growth, so the canopy is never cropped.
      const cam = easeInOut(clamp01(p / 0.9));
      svg.setAttribute(
        'viewBox',
        `${lerp(from.x, F.x, cam)} ${lerp(from.y, F.y, cam)} ${lerp(from.w, F.w, cam)} ${lerp(from.h, F.h, cam)}`,
      );

      bar.fill.style.width = `${(p * 100).toFixed(1)}%`;
      bar.stage.textContent = stageAt(grown);
      bar.count.textContent = `${grown} note${grown === 1 ? '' : 's'}`;

      if (p < 1) raf = requestAnimationFrame(step);
      else finishReplay();
    };

    finishReplay = () => {
      cancelAnimationFrame(raf);
      finishReplay = null;
      replaying = false;
      delete root.dataset.replay;
      for (const path of document.querySelectorAll('#l-roots .root, #l-branches .branch')) {
        path.style.strokeDasharray = '';
        path.style.strokeDashoffset = '';
      }
      for (const [, { node }] of byId) node.style.scale = '';
      if (trunk) trunk.style.clipPath = '';
      if (ground) ground.style.opacity = '';
      svg.setAttribute('viewBox', `${F.x} ${F.y} ${F.w} ${F.h}`);
      applyFilter();
    };

    // A reduced-motion visitor asked for the tree, not the film.
    if (root.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches) return finishReplay();
    raf = requestAnimationFrame(step);
  }

  document.getElementById('replay').addEventListener('click', () => (replaying ? finishReplay?.() : startReplay()));
  document.getElementById('replay-stop').addEventListener('click', () => finishReplay?.());

  /* -------------------------------------------------------------- chrome -- */

  document.getElementById('view-toggle').addEventListener('click', () => {
    finishReplay?.();
    const next = root.dataset.view === 'list' ? 'tree' : 'list';
    root.dataset.view = next;
    document.getElementById('view-toggle').textContent = next === 'list' ? 'tree view' : 'list view';
    document.getElementById('view-toggle').setAttribute('aria-pressed', String(next === 'list'));
  });

  /* -------------------------------------------------------------- theme -- */

  // Daylight hours on the machine looking at the page. No geolocation, no
  // sunrise table, no setting to discover: at 9am you get paper, at 9pm ink.
  const clockTheme = () => {
    const h = new Date().getHours();
    return h >= 7 && h < 19 ? 'day' : 'night';
  };

  const themeBtn = document.getElementById('theme-toggle');
  const THEME_FACE = {
    auto: { icon: '◑', title: 'Theme: follows the clock' },
    day: { icon: '☀', title: 'Theme: always light' },
    night: { icon: '☾', title: 'Theme: always dark' },
  };

  // `persist` is false on load: the mode the page opened with may have come
  // from config, and writing it back would freeze that config value into this
  // browser forever. Only a click is a choice.
  function applyTheme(mode, persist = true) {
    root.dataset.themeMode = mode;
    root.dataset.theme = mode === 'auto' ? clockTheme() : mode;
    themeBtn.textContent = THEME_FACE[mode].icon;
    themeBtn.title = THEME_FACE[mode].title;
    themeBtn.setAttribute('aria-label', THEME_FACE[mode].title);
    if (!persist) return;
    try {
      localStorage.setItem('note-tree:theme', mode);
    } catch {
      /* private mode */
    }
  }

  themeBtn.addEventListener('click', () => {
    const order = ['auto', 'day', 'night'];
    applyTheme(order[(order.indexOf(root.dataset.themeMode || 'auto') + 1) % order.length]);
  });

  // A tree left open across sunset should turn its own lights down.
  setInterval(() => {
    if ((root.dataset.themeMode || 'auto') === 'auto') root.dataset.theme = clockTheme();
  }, 60_000);

  /* ------------------------------------------------------------- search -- */

  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    applyFilter();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    search.value = '';
    query = '';
    applyFilter();
    search.blur();
  });

  document.getElementById('list').addEventListener('click', (e) => {
    const id = e.target.closest('li')?.dataset.id;
    if (id) open(id);
  });

  for (const tab of document.querySelectorAll('.tab[data-scope]')) {
    tab.addEventListener('click', async () => {
      finishReplay?.();
      for (const t of document.querySelectorAll('.tab[data-scope]')) t.setAttribute('aria-selected', String(t === tab));
      DATA.scope = tab.dataset.scope;
      if (DATA.live) {
        Object.assign(LAYOUT, await (await fetch('./api/layout?scope=' + encodeURIComponent(DATA.scope))).json());
      } else {
        Object.assign(LAYOUT, DATA.layouts[DATA.scope]);
      }
      close();
      render();
    });
  }

  // Clicking a legend entry mutes that kind — the fastest way to answer
  // "where are all my gotchas?" on a crowded tree.
  document.getElementById('legend').addEventListener('click', (e) => {
    const span = e.target.closest('span[data-kind]');
    if (!span) return;
    const kind = span.dataset.kind;
    hidden.has(kind) ? hidden.delete(kind) : hidden.add(kind);
    span.dataset.off = String(hidden.has(kind));
    applyFilter();
  });

  /* ---------------------------------------------------------------- go --- */

  // The head script already set the theme before first paint; this only syncs
  // the button's face to it.
  applyTheme(root.dataset.themeMode || 'auto', false);

  render();
  connect();
  // Root at the bottom: the page opens at the base of the tree and you scroll
  // up through time.
  window.scrollTo(0, document.body.scrollHeight);

  /* -------------------------------------------------------------- utils -- */

  function when(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const mins = (Date.now() - t) / 60000;
    if (mins < 1) return 'just now';
    if (mins < 60) return `${Math.round(mins)}m ago`;
    const h = mins / 60;
    if (h < 24) return `${Math.round(h)}h ago`;
    const d = h / 24;
    if (d < 7) return `${Math.round(d)}d ago`;
    if (d < 30) return `${Math.round(d / 7)}w ago`;
    if (d < 365) return `${Math.round(d / 30)}mo ago`;
    return `${(d / 365).toFixed(1)}y ago`;
  }

  function full(iso) {
    const t = new Date(iso);
    return Number.isNaN(+t) ? '' : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** Calendar date alone — the tooltip has no room for the time of day. */
  function day(iso) {
    const t = new Date(iso);
    return Number.isNaN(+t) ? '' : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /**
   * Markdown, the subset an agent actually writes into a note.
   *
   * Headings, lists, quotes, fenced and inline code, bold, italic, links, rules.
   * Not a spec-compliant parser and not trying to be — the job is to make a
   * paragraph read like a paragraph instead of a wall of monospace.
   *
   * Every fragment is escaped *before* any markup is added, and links are
   * limited to http(s), because note bodies arrive from other agents and are
   * data, not something the page should be persuaded by.
   */
  function markdown(src) {
    const out = [];
    let para = [];
    let list = null;
    let quote = [];
    let fence = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    const flushQuote = () => {
      if (quote.length) out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      quote = [];
    };
    const flush = () => {
      flushPara();
      flushList();
      flushQuote();
    };

    for (const raw of String(src).replace(/\r\n?/g, '\n').split('\n')) {
      if (fence) {
        if (/^\s*```/.test(raw)) {
          out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
          fence = null;
        } else fence.push(raw);
        continue;
      }
      if (/^\s*```/.test(raw)) {
        flush();
        fence = [];
        continue;
      }
      if (!raw.trim()) {
        flush();
        continue;
      }

      const head = raw.match(/^(#{1,6})\s+(.*)$/);
      if (head) {
        flush();
        // h1/h2 belong to the page, not to a note body: everything lands at h3+.
        const level = Math.min(4, head[1].length + 2);
        out.push(`<h${level}>${inline(head[2])}</h${level}>`);
        continue;
      }
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) {
        flush();
        out.push('<hr>');
        continue;
      }

      const quoted = raw.match(/^\s*>\s?(.*)$/);
      if (quoted) {
        flushPara();
        flushList();
        quote.push(quoted[1]);
        continue;
      }
      flushQuote();

      const item = raw.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        const want = /^[-*+]$/.test(item[1]) ? 'ul' : 'ol';
        flushPara();
        if (list !== want) {
          flushList();
          out.push(`<${want}>`);
          list = want;
        }
        out.push(`<li>${inline(item[2])}</li>`);
        continue;
      }
      flushList();
      para.push(raw.trim());
    }
    if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
    flush();
    return out.join('');
  }

  function inline(text) {
    let s = esc(text);
    // Code spans come out first and go back in last, so a path full of
    // underscores never turns half the sentence italic.
    const code = [];
    // `esc` has already removed every real angle bracket from the text, so a
    // bracketed index cannot collide with anything the note actually said.
    s = s.replace(/`([^`]+)`/g, (_, c) => `<${code.push(`<code>${c}</code>`) - 1}>`);
    const link = (href, label) => `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => link(href, label));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, before, href) => before + link(href, href));
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])_([^_]+)_(?![\w])/g, '$1<em>$2</em>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s.replace(/<(\d+)>/g, (_, i) => code[Number(i)]);
  }
})();
