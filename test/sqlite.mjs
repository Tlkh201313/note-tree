/**
 * Exercise the hand-rolled SQLite reader against fixtures built by node:sqlite.
 * node:sqlite is used only here — the shipped reader has no dependencies and
 * must work on Node 18, where node:sqlite doesn't exist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ok, report, fixtureSqlite, REPO, SRC, CLI } from './lib/harness.mjs';

const { DatabaseSync } = await fixtureSqlite(import.meta.url);
const { openDatabase } = await import(`${SRC}/import/sqlite.mjs`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-sqlite-'));
const file = path.join(dir, 'fixture.db');


const db = new DatabaseSync(file);
db.exec(`
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    score REAL,
    tiny INTEGER,
    big INTEGER,
    negative INTEGER,
    blob BLOB,
    emptyish TEXT,
    created_at TEXT
  );
  CREATE TABLE "weird names" ("a b" TEXT, [bracketed] TEXT, \`ticked\` TEXT, PRIMARY KEY ("a b"));
  CREATE INDEX idx_title ON memories(title);
`);

const insert = db.prepare(
  'INSERT INTO memories (title, content, score, tiny, big, negative, blob, emptyish, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
);

const LOREM = 'The quick brown fox jumps over the lazy dog. ';
// 900 rows forces interior b-tree pages; the long bodies force overflow pages.
for (let i = 0; i < 900; i++) {
  insert.run(
    `memory ${i}`,
    i % 7 === 0 ? LOREM.repeat(400) : `body for ${i} — unicode: café 🌱 ${'x'.repeat(i % 50)}`,
    i / 3,
    i % 128,
    9_007_199_254_740_991,
    -1234567,
    new Uint8Array([1, 2, 3, i % 256]),
    null,
    new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString(),
  );
}
db.prepare('INSERT INTO "weird names" ("a b", [bracketed], `ticked`) VALUES (?,?,?)').run('x', 'y', 'z');
db.close();

/* ------------------------------------------------------------------------ */

const read = openDatabase(file);
ok('tables found', read.tables.map((t) => t.name).sort().join(',') === 'memories,weird names', read.tables.map((t) => t.name).join(','));
ok('indexes excluded', !read.tables.some((t) => t.name === 'idx_title'));

const cols = read.tables.find((t) => t.name === 'memories').columns.map((c) => c.name);
ok('columns parsed', cols.join(',') === 'id,title,content,score,tiny,big,negative,blob,emptyish,created_at', cols.join(','));
ok('rowid alias detected', read.tables.find((t) => t.name === 'memories').columns[0].rowidAlias === true);

const weird = read.tables.find((t) => t.name === 'weird names').columns.map((c) => c.name);
ok('quoted/bracketed/ticked column names', weird.join(',') === 'a b,bracketed,ticked', weird.join(','));

const rows = read.read('memories');
ok('all rows read', rows.length === 900, String(rows.length));
ok('rows in rowid order', rows.every((r, i) => r.rowid === i + 1));
ok('INTEGER PRIMARY KEY filled from rowid', rows[0].id === 1 && rows[899].id === 900, `${rows[0].id}/${rows[899].id}`);
ok('text column', rows[10].title === 'memory 10', String(rows[10].title));
ok('unicode survives', rows[1].content.includes('café 🌱'));
ok('real column', Math.abs(rows[9].score - 3) < 1e-9, String(rows[9].score));
ok('small int', rows[5].tiny === 5, String(rows[5].tiny));
ok('8-byte int', rows[0].big === 9_007_199_254_740_991, String(rows[0].big));
ok('negative int', rows[0].negative === -1234567, String(rows[0].negative));
ok('blob is bytes', Buffer.isBuffer(rows[3].blob) && rows[3].blob[0] === 1 && rows[3].blob[3] === 3, JSON.stringify(rows[3].blob));
ok('null stays null', rows[0].emptyish === null);
ok('iso timestamp', rows[0].created_at === '2026-01-01T00:00:00.000Z', String(rows[0].created_at));

const overflow = rows.filter((r) => r.content.length > 10_000);
ok('overflow rows present', overflow.length === Math.ceil(900 / 7), String(overflow.length));
ok('overflow payload intact', overflow.every((r) => r.content.length === LOREM.length * 400 && r.content.endsWith('dog. ')), String(overflow[0]?.content.length));

const limited = read.read('memories', { limit: 5 });
ok('limit honoured', limited.length === 5, String(limited.length));
ok('unknown table errors', (() => { try { read.read('nope'); return false; } catch { return true; } })());
ok('no wal warning on a clean file', read.warnings.length === 0, JSON.stringify(read.warnings));

/* --- a page size other than the 4096 default, and a big page count ------- */
const file2 = path.join(dir, 'p16k.db');
const db2 = new DatabaseSync(file2);
db2.exec('PRAGMA page_size = 16384; VACUUM; CREATE TABLE t (a TEXT);');
const ins2 = db2.prepare('INSERT INTO t (a) VALUES (?)');
for (let i = 0; i < 2000; i++) ins2.run(`row ${i} ${'y'.repeat(i % 300)}`);
db2.close();
const read2 = openDatabase(file2);
ok('16k page size', read2.pageSize === 16384, String(read2.pageSize));
const rows2 = read2.read('t');
ok('2000 rows at 16k pages', rows2.length === 2000, String(rows2.length));
ok('last row intact', rows2[1999].a.startsWith('row 1999 '), String(rows2[1999].a).slice(0, 20));

/* --- not a database ------------------------------------------------------ */
const junk = path.join(dir, 'junk.db');
fs.writeFileSync(junk, Buffer.alloc(600, 7));
ok('rejects non-sqlite', (() => { try { openDatabase(junk); return false; } catch (e) { return /not a SQLite/.test(e.message); } })());

fs.rmSync(dir, { recursive: true, force: true });
report();
