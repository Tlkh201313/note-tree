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
  let selected = null;
  let hidden = new Set();

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

  function drawLeaf(leaf, { sprout = false } = {}) {
    const g = el('g', { class: 'leaf' + (sprout ? ' sprout' : ''), transform: `translate(${leaf.x} ${leaf.y}) rotate(${leaf.angle})` }, layers.leaves);
    g.setAttribute('data-id', leaf.id);
    g.setAttribute('data-kind', leaf.kind);
    g.setAttribute('data-pinned', String(leaf.pinned));
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${leaf.kind}: ${leaf.title}, ${when(leaf.updated)}`);
    g.style.color = leaf.color;
    g.style.opacity = leaf.opacity;

    // A leaf, not a circle: two arcs meeting at a point, with a midrib.
    const r = leaf.r;
    el('path', {
      d: `M 0 ${-r * 1.5} C ${r * 1.25} ${-r * 0.5}, ${r * 0.8} ${r * 0.95}, 0 ${r * 1.5} C ${-r * 0.8} ${r * 0.95}, ${-r * 1.25} ${-r * 0.5}, 0 ${-r * 1.5} Z`,
      fill: leaf.color,
    }, g);
    el('path', { d: `M 0 ${-r * 1.2} L 0 ${r * 1.2}`, stroke: 'rgba(0,0,0,.28)', 'stroke-width': Math.max(0.5, r * 0.12), fill: 'none' }, g);
    if (leaf.pinned) el('circle', { r: r * 2.05, fill: 'none', stroke: '#fde047', 'stroke-width': 1.1, opacity: 0.85 }, g);

    byId.set(leaf.id, { leaf, node: g });
    return g;
  }

  function render() {
    const L = LAYOUT;
    svg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
    svg.setAttribute('aria-label', `${L.counts.live} notes across ${L.counts.sessions} sessions, a ${L.stage} tree`);
    document.getElementById('stage').style.setProperty('--ground', `${(L.ground / L.height) * 100}%`);
    document.getElementById('stage').style.background =
      `linear-gradient(to bottom, var(--sky-top), var(--sky-bottom) ${(L.ground / L.height) * 100}%, var(--soil) ${(L.ground / L.height) * 100}%)`;

    document.getElementById('l-roots').replaceChildren();
    for (const r of L.roots) el('path', { class: 'root', d: r.d, 'stroke-width': r.width }, document.getElementById('l-roots'));

    document.getElementById('l-trunk').replaceChildren();
    el('path', { class: 'trunk', d: L.trunk.path }, document.getElementById('l-trunk'));
    el('line', { class: 'soil-line', x1: 0, y1: L.ground, x2: L.width, y2: L.ground }, document.getElementById('l-trunk'));

    layers.branches.replaceChildren();
    for (const b of L.branches) {
      const g = el('g', { class: b.index % 2 ? 'sway sway--b' : 'sway' }, layers.branches);
      el('path', { class: 'branch', d: b.d, 'stroke-width': b.width }, g);
    }

    layers.leaves.replaceChildren();
    byId.clear();
    for (const leaf of L.leaves) drawLeaf(leaf);

    document.getElementById('count').textContent = L.counts.live;
    document.getElementById('stage-name').textContent = L.stage;
    document.getElementById('sessions').textContent = L.counts.sessions;
    document.getElementById('empty').hidden = L.counts.notes > 0;
    renderList();
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
            `<span class="dot" style="background:${esc(leaf.color)}"></span>` +
            `<span>${esc(leaf.title)}</span>` +
            `<span class="when">${esc(leaf.kind)} · ${esc(when(leaf.updated))}</span></li>`,
        );
      }
      parts.push('</ol>');
    }
    wrap.innerHTML = parts.join('') || '<p>No notes yet.</p>';
  }

  /* -------------------------------------------------------- interaction -- */

  const tip = document.getElementById('tip');
  function showTip(leaf, x, y) {
    tip.querySelector('.t').textContent = leaf.title;
    tip.querySelector('.d').textContent = `${leaf.kind} · ${when(leaf.updated)}${leaf.pinned ? ' · pinned' : ''}${leaf.archived ? ' · archived' : ''}`;
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
    if (e.key === 'Escape') return close();
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hit = leafFrom(e.target);
    if (hit) {
      e.preventDefault();
      open(hit.leaf.id);
    }
  });

  /* -------------------------------------------------------------- panel -- */

  const panel = document.getElementById('sidebar');

  async function open(id) {
    const entry = byId.get(id) || { leaf: LAYOUT.leaves.find((l) => l.id === id) };
    if (!entry?.leaf) return;
    const leaf = entry.leaf;

    if (selected) selected.node?.removeAttribute('data-selected');
    selected = byId.get(id) || null;
    selected?.node?.setAttribute('data-selected', 'true');

    panel.querySelector('h2').textContent = leaf.title;
    panel.querySelector('.dot').style.background = leaf.color;
    panel.querySelector('.kind').textContent = leaf.kind;
    panel.querySelector('.desc').textContent = leaf.desc || '';
    panel.querySelector('.desc').hidden = !leaf.desc;
    panel.querySelector('.meta').innerHTML =
      [
        `<span>${esc(leaf.scope)}</span>`,
        leaf.agent ? `<span> · via ${esc(leaf.agent)}</span>` : '',
        `<span> · ${esc(full(leaf.created))}</span>`,
        leaf.reads ? `<span> · ${leaf.reads} recall${leaf.reads === 1 ? '' : 's'}</span>` : '',
        '<br>',
        (leaf.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join(''),
      ].join('');
    panel.querySelector('.body').textContent = leaf.body ?? 'Loading…';
    panel.dataset.open = 'true';
    panel.querySelector('.close').focus({ preventScroll: true });
    for (const b of panel.querySelectorAll('.actions button[data-action]')) b.hidden = !DATA.live;

    // Bodies aren't in the payload when the page is live — that's what keeps
    // the initial load small. Fetch on demand, once, then cache on the leaf.
    if (leaf.body === undefined && DATA.live) {
      try {
        const res = await fetch(`./api/note/${encodeURIComponent(id)}`);
        const note = await res.json();
        leaf.body = note.body || '';
        leaf.desc = note.desc || leaf.desc;
        if (panel.dataset.open === 'true') {
          panel.querySelector('.body').textContent = leaf.body;
          panel.querySelector('.desc').textContent = leaf.desc || '';
          panel.querySelector('.desc').hidden = !leaf.desc;
        }
      } catch {
        panel.querySelector('.body').textContent = '(could not load this note)';
      }
    } else if (leaf.body === undefined) {
      panel.querySelector('.body').textContent = '(body not included in this export)';
    }
  }

  function close() {
    panel.dataset.open = 'false';
    if (selected) selected.node?.removeAttribute('data-selected');
    selected = null;
  }
  panel.querySelector('.close').addEventListener('click', close);

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
      const fresh = await (await fetch('./api/layout?scope=' + encodeURIComponent(DATA.scope))).json();
      const known = new Set(LAYOUT.leaves.map((l) => l.id));
      Object.assign(LAYOUT, fresh);
      render();
      // The new leaf gets the sprout animation; everything else just redraws.
      const sprouted = LAYOUT.leaves.find((l) => !known.has(l.id)) || LAYOUT.leaves.find((l) => l.id === ev.id);
      const node = sprouted && byId.get(sprouted.id)?.node;
      if (node) {
        node.classList.add('sprout');
        node.scrollIntoView({ block: 'center', behavior: root.dataset.motion === 'off' ? 'auto' : 'smooth' });
      }
    });
    es.onerror = () => {
      document.getElementById('live').dataset.state = 'off';
    };
  }

  /* -------------------------------------------------------------- chrome -- */

  document.getElementById('view-toggle').addEventListener('click', () => {
    const next = root.dataset.view === 'list' ? 'tree' : 'list';
    root.dataset.view = next;
    document.getElementById('view-toggle').textContent = next === 'list' ? 'tree view' : 'list view';
    document.getElementById('view-toggle').setAttribute('aria-pressed', String(next === 'list'));
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'day' ? 'night' : 'day';
    try {
      localStorage.setItem('note-tree:theme', root.dataset.theme);
    } catch {
      /* private mode */
    }
  });

  document.getElementById('list').addEventListener('click', (e) => {
    const id = e.target.closest('li')?.dataset.id;
    if (id) open(id);
  });

  for (const tab of document.querySelectorAll('.tab[data-scope]')) {
    tab.addEventListener('click', async () => {
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
    for (const [, { leaf, node }] of byId) {
      node.setAttribute('data-dim', String(hidden.size > 0 && hidden.has(leaf.kind)));
    }
  });

  /* ---------------------------------------------------------------- go --- */

  try {
    const saved = localStorage.getItem('note-tree:theme');
    if (saved) root.dataset.theme = saved;
  } catch {
    /* private mode */
  }

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

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();
