/**
 * A read-only SQLite reader, in about 200 lines and zero dependencies.
 *
 * Why this exists: the single highest-leverage thing note-tree can do for
 * someone already running another memory plugin is import their history in one
 * command. Most of those plugins keep their data in SQLite. Taking a native
 * dependency for that would cost every user an install step and a build
 * toolchain, to serve a code path that runs exactly once.
 *
 * So: the file format is public, stable since 2004, and small enough to read
 * directly. We only need SELECT-everything, which is a b-tree walk and a record
 * decoder — no query planner, no writes, no locking.
 *
 * Deliberately not supported (each reports rather than guesses):
 *   - WITHOUT ROWID tables, which live in index b-trees
 *   - encrypted or corrupt files
 *   - rows still sitting in an un-checkpointed `-wal` sidecar
 */

import fs from 'node:fs';

const MAGIC = 'SQLite format 3\0';

/** Serial-type → byte width, for the fixed-width integer types. */
const INT_WIDTH = [0, 1, 2, 3, 4, 6, 8];

/**
 * @returns `{ tables, read(name, opts), warnings }`
 */
export function openDatabase(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 512 || buf.toString('latin1', 0, 16) !== MAGIC) {
    throw new Error('not a SQLite database');
  }

  const pageSize = buf.readUInt16BE(16) === 1 ? 65_536 : buf.readUInt16BE(16);
  const usable = pageSize - buf[20];
  const pageCount = Math.floor(buf.length / pageSize);
  const warnings = [];

  // Rows written since the last checkpoint live in the sidecar, not the file.
  // Silently importing a stale snapshot would be worse than saying so.
  if (fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size > 0) {
    warnings.push('a -wal sidecar exists: rows written since the last checkpoint are not visible');
  }

  const page = (n) => {
    if (n < 1 || n > pageCount) throw new Error(`page ${n} is out of range`);
    return buf.subarray((n - 1) * pageSize, n * pageSize);
  };

  /** Every table-leaf cell under `root`, depth-first, left to right. */
  function* walk(root) {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const no = stack.pop();
      if (!no || seen.has(no)) continue; // a cycle means corruption, not more data
      seen.add(no);

      const p = page(no);
      const off = no === 1 ? 100 : 0;
      const type = p[off];
      const cells = p.readUInt16BE(off + 3);

      if (type === 0x0d) {
        for (let i = 0; i < cells; i++) yield leafCell(p, p.readUInt16BE(off + 8 + i * 2));
      } else if (type === 0x05) {
        // Push right-most first so the stack pops children in key order.
        stack.push(p.readUInt32BE(off + 8));
        for (let i = cells - 1; i >= 0; i--) {
          stack.push(p.readUInt32BE(p.readUInt16BE(off + 12 + i * 2)));
        }
      } else if (type === 0x0a || type === 0x02) {
        throw new Error('index b-tree (WITHOUT ROWID tables are not supported)');
      }
    }
  }

  /**
   * One row's payload, following overflow pages when the record is too big to
   * fit locally. The spilling maths is fixed by the format — these constants are
   * from the file-format spec, not tuning.
   */
  function leafCell(p, ptr) {
    let at = ptr;
    const size = varint(p, at);
    at += size.width;
    const rowid = varint(p, at);
    at += rowid.width;

    const maxLocal = usable - 35;
    let local = size.value;
    if (size.value > maxLocal) {
      const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
      local = minLocal + ((size.value - minLocal) % (usable - 4));
      if (local > maxLocal) local = minLocal;
    }

    let payload = p.subarray(at, at + local);
    if (size.value > local) {
      const chunks = [payload];
      let next = p.readUInt32BE(at + local);
      let left = size.value - local;
      while (next && left > 0) {
        const over = page(next);
        next = over.readUInt32BE(0);
        const take = Math.min(usable - 4, left);
        chunks.push(over.subarray(4, 4 + take));
        left -= take;
      }
      payload = Buffer.concat(chunks);
    }
    return { rowid: rowid.value, payload };
  }

  /* ---------------------------------------------------------- catalogue --- */

  const tables = [];
  for (const cell of walk(1)) {
    const [type, name, , rootpage, sql] = decodeRecord(cell.payload);
    if (type !== 'table' || !rootpage) continue;
    if (String(name).startsWith('sqlite_')) continue; // internal bookkeeping
    tables.push({ name: String(name), root: Number(rootpage), sql: sql ? String(sql) : '', columns: columnsOf(sql) });
  }

  /**
   * Rows as plain objects. Unknown columns fall back to positional `col0`
   * names so a table whose DDL we couldn't parse still imports.
   */
  function read(name, { limit = Infinity } = {}) {
    const table = tables.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
    if (!table) throw new Error(`no table "${name}"`);

    const out = [];
    for (const cell of walk(table.root)) {
      if (out.length >= limit) break;
      const values = decodeRecord(cell.payload);
      const row = {};
      values.forEach((v, i) => {
        const col = table.columns[i];
        // `INTEGER PRIMARY KEY` is an alias for the rowid and is stored as NULL.
        row[col?.name || `col${i}`] = v === null && col?.rowidAlias ? cell.rowid : v;
      });
      row.rowid = cell.rowid;
      out.push(row);
    }
    return out;
  }

  return { file, pageSize, tables, read, warnings };
}

/* ------------------------------------------------------------ decoding --- */

/** Big-endian base-128, 1–9 bytes; the ninth byte contributes all 8 bits. */
function varint(buf, at) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = buf[at + i];
    if (byte === undefined) return { value, width: i };
    if (i === 7) return { value: value * 256 + byte, width: 9 };
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return { value, width: i + 1 };
  }
  return { value, width: 9 };
}

function decodeRecord(payload) {
  const header = varint(payload, 0);
  const types = [];
  let at = header.width;
  while (at < header.value) {
    const t = varint(payload, at);
    types.push(t.value);
    at += t.width;
  }

  const values = [];
  let d = header.value;
  for (const t of types) {
    if (t === 0) values.push(null);
    else if (t >= 1 && t <= 6) {
      const width = INT_WIDTH[t];
      values.push(readSigned(payload, d, width));
      d += width;
    } else if (t === 7) {
      values.push(payload.length >= d + 8 ? payload.readDoubleBE(d) : null);
      d += 8;
    } else if (t === 8) values.push(0);
    else if (t === 9) values.push(1);
    else if (t >= 12 && t % 2 === 0) {
      const len = (t - 12) / 2;
      values.push(payload.subarray(d, d + len));
      d += len;
    } else if (t >= 13) {
      const len = (t - 13) / 2;
      values.push(payload.toString('utf8', d, d + len));
      d += len;
    } else values.push(null);
  }
  return values;
}

/** Two's-complement big-endian of any width SQLite uses (1,2,3,4,6,8 bytes). */
function readSigned(buf, at, width) {
  if (at + width > buf.length) return null;
  if (width === 8) {
    const big = buf.readBigInt64BE(at);
    // Timestamps and ids are the point here; anything past 2^53 is not a number
    // we can safely round-trip, so it stays a string rather than losing digits.
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(big)
      : big.toString();
  }
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + buf[at + i];
  const ceiling = 2 ** (width * 8);
  return value >= ceiling / 2 ? value - ceiling : value;
}

/* ------------------------------------------------------------------ DDL --- */

const NOT_A_COLUMN = /^(constraint|primary|unique|check|foreign|key)$/i;

/**
 * Column names from `CREATE TABLE`. A light parser on purpose: it only has to
 * survive real DDL, and anything it can't read degrades to positional names.
 */
function columnsOf(sql) {
  const text = String(sql || '');
  const open = text.indexOf('(');
  if (open === -1) return [];
  const body = text.slice(open + 1, text.lastIndexOf(')'));

  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);

  const out = [];
  for (const part of parts) {
    const def = part.trim();
    if (!def) continue;
    const m = def.match(/^("([^"]*)"|`([^`]*)`|\[([^\]]*)\]|[A-Za-z_][\w$]*)/);
    if (!m) continue;
    const name = m[2] ?? m[3] ?? m[4] ?? m[1];
    if (NOT_A_COLUMN.test(name)) continue;
    out.push({ name, rowidAlias: /\bINTEGER\s+PRIMARY\s+KEY\b/i.test(def) });
  }
  return out;
}
