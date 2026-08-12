/**
 * Reading another tool's store.
 *
 * Written defensively on purpose. claude-mem's on-disk layout has changed
 * across releases — SQLite, a vector index, JSONL archives, all in a directory
 * whose shape we can't pin down from outside — so this does not encode a schema
 * it can't verify. It finds the files, works out what each one is, pulls out
 * anything that looks like a memory, and reports exactly what it took and what
 * it left. A wrong guess shows up as a skipped record in `--dry-run`, not as
 * silent data loss.
 *
 * The same code reads any JSON, JSONL or SQLite export, which is why the
 * generic `--from json` source is three lines at the bottom of this file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from './sqlite.mjs';

/** Where claude-mem has kept its data across the versions we know of. */
export const CLAUDE_MEM_HOMES = [
  process.env.CLAUDE_MEM_HOME,
  path.join(os.homedir(), '.claude-mem'),
  path.join(os.homedir(), '.claude', 'claude-mem'),
  path.join(os.homedir(), '.local', 'share', 'claude-mem'),
].filter(Boolean);

const DATA_EXT = new Set(['.jsonl', '.ndjson', '.json', '.db', '.sqlite', '.sqlite3']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'cache', '.cache', 'tmp', 'bin']);
/** Reading a multi-gigabyte vector index into memory helps nobody. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Table names that suggest curated memory rather than plumbing. */
const TABLE_HINT = /(memor|observ|summar|note|insight|fact|knowledge|document|entit|chunk)/i;
/** …and the ones that are plumbing. */
const TABLE_NOISE = /(migration|schema|collection|segment|embedding_fulltext|_fts|_data|sqlite_|queue|lock|config|setting)/i;

export function findClaudeMemHome() {
  return CLAUDE_MEM_HOMES.find((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }) || null;
}

/**
 * Collect candidate records.
 *
 * @param opts.from   an explicit file or directory
 * @param opts.table  read only this SQLite table
 * @param opts.limit  stop after this many records
 * @returns `{ records, warnings, files, home }`
 */
export function readStore({ from = null, table = null, limit = 20_000 } = {}) {
  const target = from || findClaudeMemHome();
  if (!target) {
    throw new Error(`no claude-mem store found (looked in ${CLAUDE_MEM_HOMES.join(', ')})`);
  }

  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? dataFiles(target) : [target];
  if (!files.length) throw new Error(`no readable data files under ${target}`);

  const records = [];
  const warnings = [];
  const used = [];

  for (const file of files) {
    if (records.length >= limit) break;
    try {
      const got = readFile(file, { table, limit: limit - records.length });
      if (!got.records.length) continue;
      records.push(...got.records);
      warnings.push(...got.warnings);
      used.push({ file, kind: got.kind, count: got.records.length, tables: got.tables });
    } catch (error) {
      // One unreadable file is a note in the report, not the end of the import.
      warnings.push(`${path.basename(file)}: ${error.message}`);
    }
  }

  return { records, warnings, files: used, home: stat.isDirectory() ? target : path.dirname(target) };
}

/** One file, whatever it turns out to be. */
export function readFile(file, { table = null, limit = Infinity } = {}) {
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  if (size > MAX_FILE_BYTES) throw new Error(`${(size / 1e6).toFixed(0)} MB is too large to read`);
  if (size === 0) return { kind: 'empty', records: [], warnings: [], tables: [] };

  if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3' || isSqlite(file)) {
    return readSqliteFile(file, { table, limit });
  }
  if (ext === '.jsonl' || ext === '.ndjson') return readJsonl(file, limit);
  return readJson(file, limit);
}

/* ------------------------------------------------------------------ json -- */

function readJsonl(file, limit) {
  const records = [];
  const warnings = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (records.length >= limit) break;
    const text = line.trim();
    if (!text || text.startsWith('//')) continue;
    try {
      const value = JSON.parse(text);
      for (const r of unwrap(value)) records.push(tag(r, file));
    } catch {
      bad++;
    }
  }
  if (bad) warnings.push(`${path.basename(file)}: ${bad} line${bad === 1 ? '' : 's'} were not valid JSON`);
  return { kind: 'jsonl', records, warnings, tables: [] };
}

function readJson(file, limit) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { kind: 'json', records: unwrap(value).slice(0, limit).map((r) => tag(r, file)), warnings: [], tables: [] };
}

/**
 * Find the records inside a JSON document.
 *
 * Exports are wrapped in every imaginable way — a bare array, `{items: […]}`,
 * `{data: {memories: […]}}` — so this looks for the longest array of objects
 * rather than insisting on a key name.
 */
function unwrap(value, depth = 0) {
  if (Array.isArray(value)) return value.filter((v) => v && typeof v === 'object');
  if (!value || typeof value !== 'object') return [];
  if (depth > 3) return [];

  let best = [];
  for (const v of Object.values(value)) {
    const found = unwrap(v, depth + 1);
    if (found.length > best.length) best = found;
  }
  // An object with no nested array is presumably one record.
  return best.length ? best : [value];
}

/* ---------------------------------------------------------------- sqlite -- */

function isSqlite(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return head.toString('latin1') === 'SQLite format 3\0';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readSqliteFile(file, { table, limit }) {
  const db = openDatabase(file);
  const wanted = table
    ? db.tables.filter((t) => t.name.toLowerCase() === table.toLowerCase())
    : db.tables.filter(memoryish);

  if (table && !wanted.length) {
    throw new Error(`no table "${table}" (has ${db.tables.map((t) => t.name).join(', ') || 'none'})`);
  }

  const records = [];
  const warnings = [...db.warnings];
  const tables = [];
  for (const t of wanted) {
    if (records.length >= limit) break;
    try {
      const rows = db.read(t.name, { limit: limit - records.length });
      if (!rows.length) continue;
      tables.push({ name: t.name, rows: rows.length });
      for (const row of rows) records.push(tag({ ...row, _table: t.name }, file));
    } catch (error) {
      warnings.push(`${path.basename(file)}:${t.name}: ${error.message}`);
    }
  }

  if (!records.length && !table) {
    warnings.push(
      `${path.basename(file)}: no memory-like tables (found ${db.tables.map((t) => t.name).join(', ') || 'none'}) — retry with --table <name>`,
    );
  }
  return { kind: 'sqlite', records, warnings, tables };
}

/**
 * Is this table worth reading?
 *
 * Named like memory, or simply has enough text columns to be carrying prose.
 * Vector tables are excluded by name: an embedding blob imports as line noise.
 */
function memoryish(table) {
  if (TABLE_NOISE.test(table.name)) return false;
  if (TABLE_HINT.test(table.name)) return true;
  const text = (table.columns || []).filter((c) => /(text|content|body|summary|note|title|value|document)/i.test(c.name));
  return text.length >= 1 && (table.columns || []).length <= 24;
}

/* ----------------------------------------------------------------- files -- */

/** Data files under a directory, two levels deep, newest first. */
function dataFiles(root, depth = 2) {
  const out = [];
  const walk = (dir, left) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (left > 0 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full, left - 1);
        continue;
      }
      if (DATA_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(root, depth);

  return out.sort((a, b) => {
    // A store's own database is more likely to be the real memory than a
    // settings file that happens to sit next to it.
    const rank = (f) => (/(\.db|\.sqlite3?)$/i.test(f) ? 0 : /(memor|archive|history|index)/i.test(path.basename(f)) ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

function tag(record, file) {
  return record && typeof record === 'object' ? { ...record, _file: path.basename(file) } : record;
}
