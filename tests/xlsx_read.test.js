'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readXlsxFirstSheet, colToIndex, decodeEntities } = require('../lib/xlsx_read');

// ---------- minimal ZIP writer (test fixture only) ----------
// Builds a real .xlsx (ZIP) from parts so we exercise the actual central-
// directory + local-header + inflate path. The reader ignores CRCs, so we
// write 0. Supports stored (method 0) and deflate (method 8) entries.
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  entries.forEach(e => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.deflate ? 8 : 0;
    const stored = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);            // crc (ignored)
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    chunks.push(local, nameBuf, stored);
    offset += local.length + nameBuf.length + stored.length;

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(0, 16);              // crc
    cen.writeUInt32LE(stored.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(localOffset, 42);
    central.push({ cen, nameBuf });
  });
  const centralStart = offset;
  central.forEach(c => { chunks.push(c.cen, c.nameBuf); offset += c.cen.length + c.nameBuf.length; });
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

const SHARED = [
  'שם', 'בית', 'שעות', 'טיפולים',    // 0..3 headers
  'דנה כהן', 'קיסריה עפרוני', 'יוסי לוי',  // 4..6 data
];
function sharedStringsXml() {
  const items = SHARED.map(s =>
    `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('');
  return `<?xml version="1.0"?><sst count="${SHARED.length}" uniqueCount="${SHARED.length}">${items}</sst>`;
}
function sheetXml() {
  return `<?xml version="1.0"?><worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>` +
    `<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>92</v></c></row>` +
    `<row r="3"><c r="A3" t="inlineStr"><is><t>יוסי לוי</t></is></c><c r="D3"><v>9</v></c></row>` +
    `</sheetData></worksheet>`;
}
function makeXlsx({ deflate = false } = {}) {
  return makeZip([
    { name: 'xl/sharedStrings.xml', data: sharedStringsXml(), deflate },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(), deflate },
  ]);
}

test('colToIndex: letters → 0-based index', () => {
  assert.equal(colToIndex('A1'), 0);
  assert.equal(colToIndex('B2'), 1);
  assert.equal(colToIndex('Z9'), 25);
  assert.equal(colToIndex('AA1'), 26);
  assert.equal(colToIndex('AB10'), 27);
});

test('decodeEntities: xml + numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B');
});

test('readXlsxFirstSheet: stored entries → header + data rows with shared strings', () => {
  const rows = readXlsxFirstSheet(makeXlsx({ deflate: false }));
  assert.deepEqual(rows[0], ['שם', 'בית', 'שעות', 'טיפולים']);
  assert.deepEqual(rows[1], ['דנה כהן', 'קיסריה עפרוני', '92']);
});

test('readXlsxFirstSheet: DEFLATE entries decode identically (inflate path)', () => {
  const rows = readXlsxFirstSheet(makeXlsx({ deflate: true }));
  assert.deepEqual(rows[0], ['שם', 'בית', 'שעות', 'טיפולים']);
  assert.deepEqual(rows[1], ['דנה כהן', 'קיסריה עפרוני', '92']);
});

test('readXlsxFirstSheet: inline strings resolve; sparse cells fill with empty', () => {
  const rows = readXlsxFirstSheet(makeXlsx());
  // Row 3 has A (inline "יוסי לוי") and D (9), B/C are gaps → ''.
  assert.equal(rows[2][0], 'יוסי לוי');
  assert.equal(rows[2][1], '');
  assert.equal(rows[2][2], '');
  assert.equal(rows[2][3], '9');
});

test('readXlsxFirstSheet: throws on a non-xlsx buffer', () => {
  assert.throws(() => readXlsxFirstSheet(Buffer.from('not a zip at all')),
    /no End Of Central Directory/);
});
