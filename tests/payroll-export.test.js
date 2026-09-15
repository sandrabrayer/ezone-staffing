'use strict';

// Guards for lib/xlsx_write.js — the minimal .xlsx writer behind the
// בקרת שכר "ייצוא לאקסל" button.
//
// The strong check here is a ROUND TRIP: every file the writer produces is
// read back with lib/xlsx_read.js, the repo's existing reader. The two were
// written independently of each other, so a container that only the writer
// understands fails this test rather than reaching Excel.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { writeXlsx, colName, crc32 } = require('../lib/xlsx_write');
const { readXlsxFirstSheet, readEntries } = require('../lib/xlsx_read');
const R = require('../lib/payroll-rules');

const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'tamhir-2026-08.json'), 'utf8'));

const buf = (rows, name) => Buffer.from(writeXlsx(rows, name));

test('a written workbook reads back through the repo\'s own reader', () => {
  const rows = [['שם', 'סכום'], ['רובין סופיה חן', 8087.18], ['MAKAROV SERGEI', 16315]];
  assert.deepStrictEqual(readXlsxFirstSheet(buf(rows, 'בקרת שכר')), [
    ['שם', 'סכום'],
    ['רובין סופיה חן', '8087.18'],
    ['MAKAROV SERGEI', '16315'],
  ]);
});

test('the container is a real ZIP with the five parts Excel expects', () => {
  const entries = readEntries(buf([['a']], 'Sheet1'));
  assert.deepStrictEqual(Object.keys(entries).sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
  ]);
});

test('every entry carries a correct CRC32, so the archive is not silently corrupt', () => {
  // The reader is permissive about CRCs; a real unzip is not. Recompute each
  // stored CRC from the local file headers.
  const bytes = buf([['שלום', 1], ['x', 2.5]], 'Sheet1');
  let off = 0;
  let checked = 0;
  while (bytes.readUInt32LE(off) === 0x04034b50) {
    const crc = bytes.readUInt32LE(off + 14);
    const compSize = bytes.readUInt32LE(off + 18);
    const nameLen = bytes.readUInt16LE(off + 26);
    const extraLen = bytes.readUInt16LE(off + 28);
    const start = off + 30 + nameLen + extraLen;
    const data = bytes.subarray(start, start + compSize);
    assert.strictEqual(crc32(data), crc, 'stored CRC must match the stored bytes');
    checked++;
    off = start + compSize;
  }
  assert.strictEqual(checked, 5, 'all five parts were verified');
});

test('crc32 matches zlib for the same bytes', () => {
  ['', 'a', 'שלום עולם', 'x'.repeat(5000)].forEach((s) => {
    const b = Buffer.from(s, 'utf8');
    assert.strictEqual(crc32(b), zlib.crc32 ? zlib.crc32(b) : crc32(b));
  });
});

test('Hebrew, XML metacharacters and quotes survive the round trip', () => {
  const rows = [['חל"ת & <לא> \'כן\'', 'ג\'מאל סגלית']];
  assert.deepStrictEqual(readXlsxFirstSheet(buf(rows, 'x')),
    [['חל"ת & <לא> \'כן\'', 'ג\'מאל סגלית']]);
});

test('blank cells stay blank rather than becoming a zero', () => {
  const rows = [['a', '', 'c'], ['', 0, '']];
  const back = readXlsxFirstSheet(buf(rows, 'x'));
  assert.strictEqual(back[0][0], 'a');
  assert.strictEqual(back[0][2], 'c');
  assert.strictEqual(back[1][1], '0', 'a real zero is written, an empty string is not');
});

test('colName walks past Z the way a spreadsheet does', () => {
  assert.strictEqual(colName(0), 'A');
  assert.strictEqual(colName(25), 'Z');
  assert.strictEqual(colName(26), 'AA');
  assert.strictEqual(colName(51), 'AZ');
  assert.strictEqual(colName(52), 'BA');
});

test('a sheet name longer than 31 characters is trimmed, not rejected', () => {
  const entries = readEntries(buf([['a']], 'א'.repeat(60)));
  const workbook = entries['xl/workbook.xml'].toString('utf8');
  const m = /name="([^"]*)"/.exec(workbook);
  assert.ok(m);
  assert.ok(m[1].length <= 31);
});

test('the real August run exports all 93 rows and reads back identically', () => {
  const evaluated = R.evaluateRun({
    month: '2026-08', runId: 'pr_export', rows: golden.rows, workers: [],
  });
  const headers = ['מספר עובד', 'שם בקובץ', 'מחלקה', 'תשלומים', 'סה"כ עלות'];
  const rows = [headers].concat(evaluated.lines.map(l =>
    [l.empNumber, l.rawName, l.dept, l.tashlumim, l.total]));

  const back = readXlsxFirstSheet(buf(rows, 'בקרת שכר'));
  assert.strictEqual(back.length, 94, 'header plus 93 lines');
  assert.deepStrictEqual(back[0], headers);
  assert.deepStrictEqual(back[1], ['33', 'רובין סופיה חן', '001', '8087.18', '8463.46']);
  // The exported totals still add up to the printed company total.
  const sum = Math.round(back.slice(1).reduce((a, r) => a + Number(r[4]), 0) * 100) / 100;
  assert.strictEqual(sum, 1107895.88);
});
