# Contributing

Thanks for looking. This project has three rules that shape everything else, and
they're worth reading before you write code.

1. **Zero runtime dependencies.** Not "few". Zero. note-tree runs on the session
   hot path, so every dependency would be startup cost and another package with a
   shell into your context. CI fails if `dependencies` is non-empty. This includes
   dev dependencies: tests use `node:test` and nothing else.
2. **Fail open.** Nothing note-tree does may break someone's session. Every hook
   wraps its body in try/catch, self-times out, and exits `0` printing nothing on
   any error. Losing memory for one session is acceptable; losing the session is not.
3. **Tokens are the product.** Anything that grows the session-start block needs to
   justify itself in the same terms a feature would. `node test/bench.mjs` fails the
   build if SessionStart exceeds 150 ms at 1,000 notes.

## Getting set up

```bash
git clone <your fork>
cd note-tree
node test/run.mjs          # no install step — there's nothing to install
node test/bench.mjs
```

Everything runs against a temporary `NOTE_TREE_HOME`, so tests never touch your
real memory. If you're testing the CLI by hand, do the same:

```bash
NOTE_TREE_HOME=/tmp/nt-scratch node bin/note-tree.mjs demo
```

## Adding support for another agent CLI

This is the most useful contribution you can make, and it's meant to be a
one-object pull request. Add an entry to `src/agents/registry.mjs`:

```js
{
  id: 'yourtool',
  name: 'Your Tool',
  tiers: ['B', 'C'],              // A = session hook, B = context file, C = MCP
  confidence: 'community',        // 'verified' only with first-party docs
  detect: [h('.yourtool')],       // paths that prove it's installed
  mcp: { scope: 'user', file: h('.yourtool', 'config.json'), format: 'json', key: 'mcpServers' },
  contextFile: { file: 'AGENTS.md' },
}
```

Then run `node test/run.mjs` — the adapter suite is table-driven, so your entry is
tested automatically: wiring must parse as that tool's format, be idempotent, leave
pre-existing user config untouched, and back up any file it edits.

Two things we ask for:

- **`confidence: 'verified'` needs a first-party source.** Link the docs in the PR.
  If you're going from a blog post or a GitHub comment, it's `'community'`, and it
  ships marked experimental. We'd rather under-claim than have a user find out the
  hard way.
- **Say whether you ran it.** "Wired it, opened the tool, memory appeared" is worth
  more than any amount of code review here.

## Pull requests

- One thing per PR.
- `node test/run.mjs` and `node test/bench.mjs` both pass.
- New behaviour comes with an assertion. The suites are plain scripts — add to the
  one that fits.
- Match the surrounding style: comments explain *why*, never *what*. If a comment
  restates the code, delete it.
- No new files unless the change genuinely needs one.

By opening a pull request you agree that your contribution is licensed under the
same [MIT licence](LICENSE) as the rest of the project. There's no CLA to sign —
this line is the whole of it, and it's here so the terms are stated rather than
assumed.

## Reporting a bug

Include your OS, `node --version`, the agent CLI and its version, and the output of:

```bash
note-tree doctor
```

`doctor` prints the cold-start time, what's wired where, the seed size, and any
config problems — it answers most of the questions we'd otherwise have to ask.

Security issues go through the Security tab instead — see [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

The version lives in four places — `package.json`, `src/cli/index.mjs`,
`.claude-plugin/plugin.json` and the `CHANGELOG.md` heading — and
`test/repo.mjs` fails the build if they disagree, so bump them together:

```bash
git tag -a v0.1.1 -m "note-tree v0.1.1" && git push --follow-tags
```

`.github/workflows/release.yml` takes it from there: full suite on Linux and
Windows, then `npm publish` via **Trusted Publishing** (OIDC) — no token is
stored in this repository, and every tarball carries a provenance attestation
tying it to the commit that built it.

