/**
 * Help output.
 *
 * The top-level screen is the first thing most people see, so it earns its
 * space: what note-tree is, the three commands that matter on day one, then
 * everything else grouped by what you're trying to do.
 */

import { COMMANDS, GROUPS, findCommand } from './registry.mjs';
import { bold, dim, cyan, green, gray, say, wrap, pad, width, SYM } from './out.mjs';
import { KINDS } from '../config.mjs';
import { kindGlyph, kindColor } from './out.mjs';

export const TAGLINE = 'Memory that grows, not memory that bloats.';

export function mainHelp() {
  const lines = [];
  lines.push(`${bold(green('note-tree'))} ${dim(SYM.leaf)} ${TAGLINE}`);
  lines.push('');
  lines.push(
    wrap(
      'Your agent saves the few things worth remembering. note-tree ranks them, ' +
        'budgets them, and hands the same memory to every CLI you use.',
      Math.min(78, process.stdout.columns || 78),
    ),
  );
  lines.push('');
  lines.push(`  ${dim('$')} note-tree init      ${dim('wire it into your CLIs')}`);
  lines.push(`  ${dim('$')} note-tree tree      ${dim('watch the tree grow')}`);
  lines.push(`  ${dim('$')} note-tree seed      ${dim('see exactly what a session costs')}`);

  const nameWidth = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  for (const group of GROUPS) {
    const inGroup = COMMANDS.filter((c) => c.group === group);
    if (!inGroup.length) continue;
    lines.push('');
    lines.push(bold(group));
    for (const c of inGroup) {
      const alias = c.aliases?.length ? dim(`, ${c.aliases[0]}`) : '';
      const label = `  ${cyan(c.name)}${alias}`;
      lines.push(`${label}${' '.repeat(Math.max(1, nameWidth + 2 - width(label) + 2))}${c.summary}`);
    }
  }

  lines.push('');
  lines.push(dim(`Run ${bold('note-tree help <command>')} for detail on any of these.`));
  lines.push(dim('Global: --root <dir>  --cwd <dir>  --json  --quiet  --no-color'));
  say(lines.join('\n'));
}

export function commandHelp(cmd) {
  const lines = [];
  lines.push(`${bold(cyan(cmd.name))} ${dim(SYM.dot)} ${cmd.summary}`);
  lines.push('');
  lines.push(`  ${cmd.usage}`);
  if (cmd.aliases?.length) lines.push(`  ${dim(`alias: ${cmd.aliases.join(', ')}`)}`);

  if (cmd.options?.length) {
    const w = Math.max(...cmd.options.map(([f]) => f.length));
    lines.push('');
    lines.push(bold('Options'));
    for (const [flag, desc] of cmd.options) lines.push(`  ${green(pad(flag, w))}  ${desc}`);
  }
  if (cmd.examples?.length) {
    lines.push('');
    lines.push(bold('Examples'));
    for (const ex of cmd.examples) lines.push(`  ${dim('$')} ${ex}`);
  }
  say(lines.join('\n'));
}

/** `note-tree help kinds` — the vocabulary, since kind drives ranking and colour. */
function kindsHelp() {
  const lines = [bold('Kinds'), ''];
  const notes = {
    decision: 'A choice and the reason behind it. The most valuable kind.',
    convention: 'How this codebase does something, when it is not obvious.',
    gotcha: 'A trap that cost real time. Ranked highest by default.',
    architecture: 'A stable structural fact about the system.',
    preference: 'How you like to work. Usually belongs in the global tree.',
    reference: 'A pointer outward: a doc, a dashboard, a ticket.',
    todo: 'Something deliberately left undone, and why.',
  };
  const w = Math.max(...KINDS.map((k) => k.length));
  for (const k of KINDS) {
    lines.push(`  ${kindColor(k, kindGlyph(k))} ${bold(pad(k, w))}  ${notes[k] || ''}`);
  }
  lines.push('');
  lines.push(dim('Kind sets a leaf’s colour and its ranking weight (`ranking.kindWeights`).'));
  say(lines.join('\n'));
}

/** The `help` command itself. */
export async function helpCommand({ positionals }) {
  const topic = positionals[0];
  if (!topic) return mainHelp();
  if (topic === 'kinds') return kindsHelp();
  const cmd = findCommand(topic);
  if (!cmd) {
    say(`${gray('No command named')} ${bold(topic)}${gray('.')}`);
    return mainHelp();
  }
  return commandHelp(cmd);
}
