#!/usr/bin/env node
/**
 * note-tree — memory that grows, not memory that bloats.
 *
 * Deliberately thin: the router decides what to load, so no command pays for
 * the ones it isn't.
 */

import { main } from '../src/cli/index.mjs';

process.exitCode = (await main()) ?? 0;
