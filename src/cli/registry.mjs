/**
 * Every command, declared once.
 *
 * The router dispatches from this table and `help` renders from it, so a
 * command can never quietly exist without documentation — or be documented and
 * not exist.
 *
 * `module` is loaded lazily. `note-tree list` should not pay to parse the
 * wiring code, the web server, or the importers.
 */

export const GROUPS = ['Start here', 'Notes', 'Curate', 'See it', 'Maintain', 'Setup'];

/** @type {Array<{name:string, aliases?:string[], group:string, summary:string, usage:string, options?:string[][], examples?:string[], module:string, fn:string, needsProject?:boolean}>} */
export const COMMANDS = [
  // ---------------------------------------------------------------- Start here
  {
    name: 'init',
    group: 'Start here',
    summary: 'Wire note-tree into the agent CLIs you use',
    usage: 'note-tree init [--agent <id|all>] [--verbosity medium] [--dry-run]',
    module: './cmd/setup.mjs',
    fn: 'init',
    options: [
      ['--agent <id|all>', 'wire a specific CLI, or every one detected (default: detected)'],
      ['--verbosity <preset>', 'minimal | medium | maximum — how much context each session gets'],
      ['--format <driver>', 'markdown (default) | jsonl | json'],
      ['--no-mcp', 'skip MCP registration; hooks and context files only'],
      ['--no-hooks', 'skip session hooks; MCP and context files only'],
      ['--absolute-node', 'use this exact node binary instead of PATH `node`'],
      ['--dry-run', 'show every file that would change, write nothing'],
    ],
    examples: [
      'note-tree init                    # detect installed CLIs and wire them',
      'note-tree init --agent all        # wire every adapter, installed or not',
      'note-tree init --verbosity minimal',
    ],
  },
  {
    name: 'demo',
    group: 'Start here',
    summary: 'Build a sample forest and open the tree — nothing to set up',
    usage: 'note-tree demo [--notes 40] [--no-open]',
    module: './cmd/view.mjs',
    fn: 'demo',
    options: [
      ['--notes <n>', 'how many sample notes to grow (default 40)'],
      ['--no-open', "don't launch a browser"],
      ['--keep', 'keep the demo store instead of using a temporary one'],
    ],
  },
  {
    name: 'help',
    group: 'Start here',
    summary: 'This screen, or detail on one command',
    usage: 'note-tree help [command]',
    module: './help.mjs',
    fn: 'helpCommand',
  },

  // -------------------------------------------------------------------- Notes
  {
    name: 'add',
    group: 'Notes',
    summary: 'Save a note',
    usage: 'note-tree add "<title>" [--body <text>] [--kind <kind>]',
    module: './cmd/notes.mjs',
    fn: 'add',
    options: [
      ['--body <text>', 'the fact and why it matters (or pipe it on stdin)'],
      ['--kind <kind>', 'decision | convention | gotcha | architecture | preference | reference | todo'],
      ['--tag <t>', 'repeatable, or comma-separated'],
      ['--global', 'save to the global tree — true in every project'],
      ['--pin', 'pin it: always survives seed trimming'],
      ['--force', 'save even if it looks like a duplicate'],
      ['--stdin', 'read the body from stdin'],
    ],
    examples: [
      'note-tree add "Routes are generated from the filesystem" --kind architecture',
      'git log -1 --format=%B | note-tree add "Why we reverted the cache" --stdin --kind decision',
    ],
  },
  {
    name: 'list',
    aliases: ['ls'],
    group: 'Notes',
    summary: 'Ranked notes for this project',
    usage: 'note-tree list [--limit 20] [--kind <k>] [--tag <t>] [--global] [--why]',
    module: './cmd/notes.mjs',
    fn: 'list',
    options: [
      ['--limit <n>', 'how many to show (default 20, 0 for all)'],
      ['--kind <k>', 'filter by kind'],
      ['--tag <t>', 'filter by tag'],
      ['--global', 'global notes only'],
      ['--project', 'project notes only'],
      ['--archived', 'include archived notes'],
      ['--pinned', 'pinned only'],
      ['--why', 'show the ranking maths behind the order'],
      ['--json', 'machine-readable output'],
    ],
  },
  {
    name: 'show',
    aliases: ['cat'],
    group: 'Notes',
    summary: 'Full text of one or more notes',
    usage: 'note-tree show <id...>',
    module: './cmd/notes.mjs',
    fn: 'show',
    options: [
      ['--json', 'machine-readable output'],
      ['--no-count', "don't record this as a read (reads feed ranking)"],
    ],
  },
  {
    name: 'search',
    aliases: ['find'],
    group: 'Notes',
    summary: 'Search project and global memory',
    usage: 'note-tree search <query> [--deep] [--limit 10]',
    module: './cmd/notes.mjs',
    fn: 'search',
    options: [
      ['--deep', 'search note bodies too, not just titles and tags'],
      ['--limit <n>', 'results to show (default 10)'],
      ['--json', 'machine-readable output'],
    ],
    examples: [
      'note-tree search pagination',
      'note-tree search "kind:gotcha auth -oauth"',
      'note-tree search tag:api scope:global',
    ],
  },
  {
    name: 'edit',
    group: 'Notes',
    summary: 'Change a note — in $EDITOR, or with flags',
    usage: 'note-tree edit <id> [--title <t>] [--body <b>] [--kind <k>]',
    module: './cmd/notes.mjs',
    fn: 'edit',
    options: [
      ['--title <t>', 'new title'],
      ['--body <t>', 'new body'],
      ['--kind <k>', 'new kind'],
      ['--tag <t>', 'replace tags'],
      ['--desc <t>', 'new one-line description'],
    ],
  },
  {
    name: 'rm',
    aliases: ['delete'],
    group: 'Notes',
    summary: 'Delete a note for good (archive is usually what you want)',
    usage: 'note-tree rm <id...> [--yes]',
    module: './cmd/notes.mjs',
    fn: 'remove',
    options: [['--yes', 'skip the confirmation']],
  },

  // ------------------------------------------------------------------- Curate
  {
    name: 'pin',
    group: 'Curate',
    summary: 'Pin a note so it always survives seed trimming',
    usage: 'note-tree pin <id...>',
    module: './cmd/notes.mjs',
    fn: 'pin',
  },
  {
    name: 'unpin',
    group: 'Curate',
    summary: 'Remove a pin',
    usage: 'note-tree unpin <id...>',
    module: './cmd/notes.mjs',
    fn: 'unpin',
  },
  {
    name: 'archive',
    group: 'Curate',
    summary: 'Retire a note — kept, but out of the seed',
    usage: 'note-tree archive <id...>',
    module: './cmd/notes.mjs',
    fn: 'archive',
  },
  {
    name: 'restore',
    group: 'Curate',
    summary: 'Bring an archived note back',
    usage: 'note-tree restore <id...>',
    module: './cmd/notes.mjs',
    fn: 'restore',
  },
  {
    name: 'promote',
    group: 'Curate',
    summary: 'Move a project note to the global tree — every project inherits it',
    usage: 'note-tree promote <id...>',
    module: './cmd/notes.mjs',
    fn: 'promote',
  },
  {
    name: 'demote',
    group: 'Curate',
    summary: 'Move a global note back into this project',
    usage: 'note-tree demote <id...>',
    module: './cmd/notes.mjs',
    fn: 'demote',
  },
  {
    name: 'prune',
    group: 'Curate',
    summary: 'Suggest notes to retire: stale, never read, superseded',
    usage: 'note-tree prune [--older-than 180d] [--unread] [--apply]',
    module: './cmd/notes.mjs',
    fn: 'prune',
    options: [
      ['--older-than <d>', 'consider notes untouched for this long (default 180d)'],
      ['--unread', 'only notes never recalled'],
      ['--kind <k>', 'restrict to a kind'],
      ['--apply', 'actually archive them (default is a dry run)'],
      ['--delete', 'delete instead of archive — irreversible'],
    ],
  },

  // ------------------------------------------------------------------- See it
  {
    name: 'tree',
    group: 'See it',
    summary: 'Open the growing tree in your browser (live)',
    usage: 'note-tree tree [--port 4747] [--no-open] [--global]',
    module: './cmd/view.mjs',
    fn: 'tree',
    options: [
      ['--port <n>', 'listen on this port (default 4747)'],
      ['--no-open', "don't launch a browser"],
      ['--global', 'open the global tree'],
      ['--plain', 'draw an ASCII tree in the terminal instead'],
    ],
  },
  {
    name: 'export',
    group: 'See it',
    summary: 'Write a self-contained tree.html — no server, no network',
    usage: 'note-tree export [--out tree.html] [--global]',
    module: './cmd/view.mjs',
    fn: 'exportTree',
    options: [
      ['--out <file>', 'destination (default ./tree.html)'],
      ['--global', 'export the global tree'],
      ['--all', 'export every project as one forest'],
    ],
  },
  {
    name: 'seed',
    group: 'See it',
    summary: 'Print the exact block a session receives, and what it costs',
    usage: 'note-tree seed [--dry-run] [--verbosity <preset>]',
    module: './cmd/view.mjs',
    fn: 'seed',
    options: [
      ['--verbosity <preset>', 'preview a different preset without saving it'],
      ['--agent <id>', 'render the envelope that agent would receive'],
      ['--json', 'machine-readable output'],
    ],
  },

  // ----------------------------------------------------------------- Maintain
  {
    name: 'status',
    group: 'Maintain',
    summary: 'What this project remembers, at a glance',
    usage: 'note-tree status [--json]',
    module: './cmd/maintain.mjs',
    fn: 'status',
  },
  {
    name: 'doctor',
    group: 'Maintain',
    summary: 'Check every moving part and say plainly what is wrong',
    usage: 'note-tree doctor [--agent <id>] [--json]',
    module: './cmd/doctor.mjs',
    fn: 'doctor',
    options: [
      ['--agent <id>', 'check one CLI in detail'],
      ['--fix', 'repair what can be repaired safely'],
    ],
  },
  {
    name: 'sync',
    group: 'Maintain',
    summary: 'Rebuild the index and refresh generated files after hand-edits',
    usage: 'note-tree sync [--all]',
    module: './cmd/maintain.mjs',
    fn: 'sync',
    options: [['--all', 'every project in the store, not just this one']],
  },
  {
    name: 'config',
    group: 'Maintain',
    summary: 'Read or change settings',
    usage: 'note-tree config <get|set|list|unset|path> [key] [value]',
    module: './cmd/config.mjs',
    fn: 'config',
    options: [
      ['--global', 'write to the global config (default)'],
      ['--project', 'write a project-only override'],
      ['--json', 'machine-readable output'],
    ],
    examples: [
      'note-tree config list',
      'note-tree config set verbosity maximum',
      'note-tree config set budget.projectNotes 24 --project',
      'note-tree config get capture.stopNudge',
    ],
  },
  {
    name: 'import',
    group: 'Maintain',
    summary: 'Bring memory in from claude-mem, MEMORY.md, or CLAUDE.md',
    usage: 'note-tree import [--from <source>] [--file <path>] [--dry-run]',
    module: './cmd/importer.mjs',
    fn: 'importCmd',
    options: [
      ['--from <source>', 'claude-mem | memory-md | claude-md | agents-md | json'],
      ['--file <path>', 'explicit source path (otherwise auto-detected)'],
      ['--global', 'import into the global tree (default: where the file lives)'],
      ['--dry-run', 'show exactly what would be imported, and write nothing'],
      ['--by-section', 'one note per heading instead of one per bullet'],
      ['--table <name>', 'read this SQLite table specifically'],
      ['--limit <n>', 'stop after n notes'],
      ['--force', 'import even when a note looks like one you already have'],
    ],
    examples: [
      'note-tree import --dry-run',
      'note-tree import --from claude-mem',
      'note-tree import --from memory-md --file ./MEMORY.md',
    ],
  },
  {
    name: 'migrate',
    group: 'Maintain',
    summary: 'Upgrade the store to the current schema, or change format',
    usage: 'note-tree migrate [--format markdown|jsonl|json]',
    module: './cmd/maintain.mjs',
    fn: 'migrate',
    options: [['--format <driver>', 'convert every note to another storage format']],
  },

  // -------------------------------------------------------------------- Setup
  {
    name: 'adapters',
    group: 'Setup',
    summary: 'Which agent CLIs are supported, detected, and wired',
    usage: 'note-tree adapters [--json]',
    module: './cmd/setup.mjs',
    fn: 'adapters',
  },
  {
    name: 'uninstall',
    group: 'Setup',
    summary: 'Remove note-tree from every CLI it was wired into',
    usage: 'note-tree uninstall [--yes] [--keep-notes]',
    module: './cmd/setup.mjs',
    fn: 'uninstall',
    options: [
      ['--yes', 'skip the confirmation'],
      ['--keep-notes', 'unwire only; leave the notes in ~/.note-tree (default)'],
      ['--purge', 'delete the note store too — irreversible'],
    ],
  },
];

const INDEX = new Map();
for (const c of COMMANDS) {
  INDEX.set(c.name, c);
  for (const a of c.aliases || []) INDEX.set(a, c);
}

export const findCommand = (name) => INDEX.get(String(name || '').toLowerCase()) || null;

/** Closest command by edit distance — for "did you mean". */
export function suggest(name) {
  const target = String(name || '').toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const key of INDEX.keys()) {
    const d = distance(target, key);
    if (d < bestScore) {
      bestScore = d;
      best = key;
    }
  }
  return bestScore <= Math.max(2, Math.floor(target.length / 3)) ? best : null;
}

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}
