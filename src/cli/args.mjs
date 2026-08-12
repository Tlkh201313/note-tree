/**
 * A ~60-line argument parser, because pulling in a dependency for this would
 * cost more startup time than everything the CLI actually does.
 *
 * Handles what the commands need and nothing more: `--flag`, `--no-flag`,
 * `--key value`, `--key=value`, `-abc` clusters, and `--` to stop parsing.
 */

/**
 * Flags that never take a value. Without this list `--json list` would swallow
 * `list` as the value of `--json`.
 */
export const BOOLEANS = new Set([
  'help', 'version', 'json', 'yes', 'force', 'dry-run', 'all', 'quiet', 'verbose',
  'global', 'project', 'pinned', 'archived', 'deep', 'why', 'open', 'color',
  'watch', 'static', 'absolute-node', 'include-global', 'plain', 'count',
  'hooks', 'mcp', 'ids', 'full', 'stdin', 'experimental', 'keep-notes',
  'pin', 'apply', 'delete', 'purge', 'keep', 'fix', 'by-section',
]);

/**
 * `--no-<x>` always means `x = false`, for every flag. That's why `no-open`
 * and friends are deliberately absent above: letting the generic rule handle
 * them keeps one flag from having two spellings in the parsed output.
 */

/** `-p` → `--project`, so common flags stay short without being cryptic. */
export const ALIASES = {
  h: 'help', v: 'version', g: 'global', p: 'project', a: 'all', f: 'force',
  q: 'quiet', n: 'limit', k: 'kind', t: 'tag', s: 'scope', y: 'yes', j: 'json',
};

const isFlag = (s) => s.startsWith('-') && s !== '-' && !/^-\d/.test(s);

export function parseArgs(argv) {
  const flags = Object.create(null);
  const positionals = [];
  let i = 0;

  const set = (key, value) => {
    const k = ALIASES[key] || key;
    if (k in flags && Array.isArray(flags[k])) flags[k].push(value);
    else if (k in flags && flags[k] !== true) flags[k] = [flags[k], value];
    else flags[k] = value;
  };

  for (; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!isFlag(token)) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith('no-') && !BOOLEANS.has(body)) {
        set(body.slice(3), false);
        continue;
      }
      const key = ALIASES[body] || body;
      if (BOOLEANS.has(key) || i + 1 >= argv.length || isFlag(argv[i + 1])) set(body, true);
      else set(body, argv[++i]);
      continue;
    }

    // Short cluster: -abc. Only the last letter may take a value.
    const letters = token.slice(1).split('');
    letters.forEach((ch, n) => {
      const key = ALIASES[ch] || ch;
      const last = n === letters.length - 1;
      if (!BOOLEANS.has(key) && last && i + 1 < argv.length && !isFlag(argv[i + 1])) {
        set(ch, argv[++i]);
      } else {
        set(ch, true);
      }
    });
  }

  return { positionals, flags };
}

/** Always an array, whether the flag was given once, many times, or not at all. */
export function many(value) {
  if (value === undefined || value === true || value === false) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Which scope the user asked for: `--global`, `--project`, `--scope x`, or all. */
export function scopeFrom(flags, fallback = 'all') {
  if (flags.global) return 'global';
  if (flags.project) return 'project';
  if (typeof flags.scope === 'string') return flags.scope;
  return fallback;
}
