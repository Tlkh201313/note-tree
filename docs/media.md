# The pictures, and where they come from

Everything visual in the README is **generated from the running code**, not drawn
by hand. That's the only way a screenshot stays true after a refactor.

## `docs/hero.svg` — the hero image

```bash
node scripts/hero.mjs                    # writes docs/hero.svg
node scripts/hero.mjs --notes 18         # the sample corpus is 18 notes
```

Left panel: the real tree layout from `src/ui/tree.mjs` — the same module the
browser and the static export call, so the picture is the product.
Right panel: the real seed block, rendered by `src/seed.mjs` from those same
notes, with its measured character and token count printed underneath.

It renders into a throwaway store (`NOTE_TREE_HOME` is redirected to a temp
directory) and uses the `note-tree demo` corpus, so it can never leak anyone's
actual memory. `now` is pinned to the newest sample note, so re-running produces
a byte-identical file instead of a diff full of shifted opacities.

Regenerate it whenever the geometry, the palette, or the seed format changes.

## `docs/index.html` — the live, clickable demo

```bash
node scripts/demo-page.mjs                 # writes docs/index.html
node scripts/demo-page.mjs --notes 48      # a fuller canopy
```

The *real* static export (`src/ui/export.mjs`), seeded with the same sample
corpus as `note-tree demo`, so the published page **is** the product: hover a
leaf, click for the note, hit replay to watch it grow, flip the theme. Only
`live: false` differs from a running server. `now` is pinned, so re-running
produces a byte-identical file rather than a diff of shifted ages, and it stands
in a fixed-size repo so its roots read as a working project's rather than the
empty temp dir it's built in.

**Publishing it (do this yourself):** Settings → Pages → *Deploy from a branch* →
`main` / `/docs`. It then serves at `https://tlkh201313.github.io/note-tree/`.
A `.nojekyll` file sits alongside it so Pages serves the HTML untouched.

**It is the only page note-tree renders that search engines may index.** Every
other export is somebody's real memory, so `renderPage` emits `noindex` unless a
caller passes `meta` — and `scripts/demo-page.mjs` is the only caller that does.
If you add another published page, pass `meta`; if you are exporting notes, don't.

The `meta` block also carries the description and the Open Graph / Twitter tags,
so the link unfurls with a headline rather than a bare URL. There is deliberately
no `og:image` yet: the hero is an SVG and card unfurlers won't render SVG, so
pointing at it would produce no card at all. To add one, record a PNG (~1200×630),
host it the way the animated hero is hosted — drag it into a GitHub issue or
release, don't commit it — and pass the resulting URL as `meta.image`. Everything
else is already wired.

## The animated hero (not yet recorded)

A GIF of the tree growing leaf by leaf as notes are saved, ~1–5 MB, replacing
`hero.svg` at the top of the README. Rules for whoever records it:

- **Host it, don't commit it.** Drag the file into a GitHub issue or release and
  use the resulting `user-images.githubusercontent.com` URL, so clones stay
  small.
- **Record the real thing.** `note-tree demo --notes 0` in one terminal, then
  `note-tree add` from a second one, so what's on screen is the live SSE growth
  path, not a mock-up.
- Keep it under ~15 seconds and start on the tree — the first frame is what
  people judge.

## Terminal recordings

CLI demos are recorded with [VHS](https://github.com/charmbracelet/vhs) `.tape`
scripts rather than by hand, so they regenerate deterministically instead of
going stale:

```text
# docs/tapes/quickstart.tape
Output docs/quickstart.gif
Set FontSize 16
Set Width 1200
Set Height 640
Type "note-tree init" Enter Sleep 2s
Type "note-tree add 'Pagination is cursor-based, never offset' --kind gotcha" Enter Sleep 2s
Type "note-tree seed --dry-run" Enter Sleep 4s
```

Run tapes against a scratch `NOTE_TREE_HOME`, never your own:

```bash
NOTE_TREE_HOME=/tmp/nt-demo vhs docs/tapes/quickstart.tape
```

## Numbers

Every number in the README comes from `node test/bench.mjs`, which prints the
markdown table ready to paste and states its method at the top of the file. If a
number can't be produced by that script, it doesn't go on the page.
