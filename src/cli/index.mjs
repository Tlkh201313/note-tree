/**
 * The router.
 *
 * Parse, resolve, lazily load one command module, run it. Nothing here touches
 * the store or the filesystem, so `note-tree --help` and a mistyped command
 * both stay instant.
 */

import path from 'node:path';
import { parseArgs } from './args.mjs';
import { findCommand, suggest } from './registry.mjs';
import { fail, say, dim, bold, cyan } from './out.mjs';

export const VERSION = '0.1.3';

export async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);

  if (flags.version || positionals[0] === 'version') {
    say(VERSION);
    return 0;
  }

  const name = positionals[0];
  if (!name || (flags.help && !name)) {
    const { mainHelp } = await import('./help.mjs');
    mainHelp();
    return 0;
  }

  const cmd = findCommand(name);
  if (!cmd) {
    const near = suggest(name);
    fail(`Unknown command "${name}".${near ? ` Did you mean ${bold(near)}?` : ''}`);
    say(dim(`Run ${cyan('note-tree help')} to see everything.`));
    return 1;
  }

  // `note-tree add --help` is the same as `note-tree help add`, which is what
  // everyone's fingers expect.
  if (flags.help) {
    const { commandHelp } = await import('./help.mjs');
    commandHelp(cmd);
    return 0;
  }

  const args = {
    positionals: positionals.slice(1),
    flags,
    root: typeof flags.root === 'string' ? flags.root : null,
    // Resolved once, here: every command compares and joins against it, and a
    // relative or shell-style path would make those comparisons lie.
    cwd: path.resolve(typeof flags.cwd === 'string' ? flags.cwd : process.cwd()),
    json: Boolean(flags.json),
    quiet: Boolean(flags.quiet),
    command: cmd,
  };

  try {
    const mod = await import(cmd.module);
    const run = mod[cmd.fn];
    if (typeof run !== 'function') throw new Error(`command "${cmd.name}" is not implemented yet`);
    const code = await run(args);
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    fail(error?.message || String(error));
    if (flags.verbose && error?.stack) console.error(dim(error.stack));
    return 1;
  }
}
