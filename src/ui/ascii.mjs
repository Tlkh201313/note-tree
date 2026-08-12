/**
 * The tree, in a terminal.
 *
 * `note-tree tree --plain` exists for the times a browser isn't there: an SSH
 * session, a container, CI. It uses the same session grouping as the SVG, so
 * what you see here and what you see in the browser are the same tree drawn two
 * ways — newest growth at the top, root at the bottom, exactly like the page.
 */

import { groupSessions } from './tree.mjs';
import { stageFor } from '../theme.mjs';
import {
  dim, bold, gray, kindColor, kindGlyph, age, width as visible, UNICODE, termWidth,
} from '../cli/out.mjs';

const BOX = UNICODE
  ? { trunk: '┃', left: '┣', right: '┫', arm: '━', rootL: '╲', rootR: '╱', soil: '~', more: '⋮' }
  : { trunk: '|', left: '|', right: '|', arm: '-', rootL: '\\', rootR: '/', soil: '~', more: ':' };

const DOT = UNICODE ? '·' : '-';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param entries      index entries (metadata only)
 * @param opts.limit   how many sessions to draw, newest first
 * @returns a string ready for `console.log`
 */
export function asciiTree(entries = [], { limit = 14, width = termWidth(), title = null } = {}) {
  const live = entries.filter((n) => !n.archived);
  const sessions = groupSessions(live).reverse(); // newest first, like the page
  const shown = sessions.slice(0, limit);
  const trunkCol = Math.max(18, Math.min(Math.floor(width * 0.42), width - 26));
  const out = [''];

  out.push(
    `  ${bold(title || 'note-tree')}  ` +
      dim(`${stageFor(live.length)} ${DOT} ${plural(live.length, 'note')} ${DOT} ${plural(sessions.length, 'session')}`),
  );
  out.push('');

  if (!shown.length) {
    out.push(`${' '.repeat(trunkCol)}${gray('.')}`);
    out.push(`${' '.repeat(Math.max(0, trunkCol - 2))}${gray(BOX.soil.repeat(5))}`);
    out.push('');
    out.push(dim('  Nothing planted yet. Save the first note with `note-tree add "…"`.'));
    out.push('');
    return out.join('\n');
  }

  if (sessions.length > shown.length) {
    const rest = sessions.length - shown.length;
    out.push(`${' '.repeat(Math.max(0, trunkCol - 1))}${dim(`${BOX.more} ${plural(rest, 'older session')}`)}`);
  }

  shown.forEach((session, i) => {
    const leaves = session.notes.map((n) => kindColor(n.kind, kindGlyph(n.kind))).join(' ');
    const label = dim(
      `${age(session.last)} ${DOT} ${plural(session.notes.length, 'note')}` +
        (session.agents.length ? ` ${DOT} ${session.agents.join(', ')}` : ''),
    );
    const arm = BOX.arm.repeat(3);

    if (i % 2 === 0) {
      // Foliage hangs left of the trunk so the label has room on the right.
      const foliage = `${leaves} ${gray(arm)}`;
      out.push(`${' '.repeat(Math.max(0, trunkCol - visible(foliage)))}${foliage}${gray(BOX.right)}  ${label}`);
    } else {
      out.push(`${' '.repeat(trunkCol)}${gray(BOX.left)}${gray(arm)} ${leaves}  ${label}`);
    }
    out.push(`${' '.repeat(trunkCol)}${gray(BOX.trunk)}`);

    // Titles for the newest session only — enough to recognise where you are
    // without turning the tree into a list.
    if (i === 0) {
      for (const n of session.notes.slice(0, 4)) {
        out.push(
          `${' '.repeat(trunkCol)}${gray(BOX.trunk)}   ${kindColor(n.kind, kindGlyph(n.kind))} ${n.title}  ${dim(n.id)}`,
        );
      }
      out.push(`${' '.repeat(trunkCol)}${gray(BOX.trunk)}`);
    }
  });

  out.push(`${' '.repeat(Math.max(0, trunkCol - 2))}${gray(`${BOX.rootR} ${BOX.trunk} ${BOX.rootL}`)}`);
  out.push(`${' '.repeat(Math.max(0, trunkCol - 4))}${gray(BOX.soil.repeat(9))}`);
  out.push('');
  return out.join('\n');
}
