'use strict';

// Minimal, read-only .xlsx reader — no third-party dependency (the popular
// `xlsx` package carries unpatched advisories, and this repo stays
// dependency-light). An .xlsx is a ZIP of XML parts; we parse the ZIP
// central directory with Node's built-in zlib for the deflated parts, then
// pull rows out of the first worksheet, resolving shared strings.
//
// Scope: enough to read a simple timesheet grid (headers + data rows).
// Reads cell text values (shared / inline / number). Not a general xlsx
// implementation — no styles, formulas evaluation, dates-as-numbers
// conversion, or streaming. Trusted-input tool (an internal timesheet),
// invoked from a Node CLI, never from the server.

const zlib = require('zlib');

// ---------- ZIP container ----------

function findEOCD(buf) {
  const SIG = 0x06054b50; // End Of Central Directory
  // The EOCD is at the very end unless there's a trailing comment; scan
  // back over the max comment size (65535) + the 22-byte record.
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  throw new Error('not an xlsx/zip file (no End Of Central Directory record)');
}

function readCentralDirectory(buf) {
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('corrupt xlsx: bad central directory signature');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const fnLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + fnLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  const o = entry.localOff;
  if (buf.readUInt32LE(o) !== 0x04034b50) {
    throw new Error('corrupt xlsx: bad local file header signature');
  }
  const fnLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const dataStart = o + 30 + fnLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);        // stored
  if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error('unsupported xlsx compression method ' + entry.method);
}

// name → decompressed Buffer for every entry in the archive.
function readEntries(buf) {
  const map = Object.create(null);
  readCentralDirectory(buf).forEach(e => { map[e.name] = extractEntry(buf, e); });
  return map;
}

// ---------- XML bits ----------

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must be last
}

// sharedStrings.xml → array of strings (index = string id). Each <si> may
// hold a single <t> or several <r><t>…</t></r> runs; concatenate the runs.
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) text += tm[1];
    out.push(decodeEntities(text));
  }
  return out;
}

// Column letters (e.g. "AB" in "AB12") → 0-based column index.
function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (let i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
  return n - 1;
}

// One worksheet XML → array of rows, each an array of string cell values.
// Cells are placed by their column reference so gaps become empty strings.
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const rMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const tMatch = /t="([^"]+)"/.exec(attrs);
      const idx = rMatch ? colToIndex(rMatch[1]) : cells.length;
      const type = tMatch ? tMatch[1] : '';
      let value = '';
      if (type === 'inlineStr') {
        let text = '';
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm2;
        while ((tm2 = tRe.exec(body))) text += tm2[1];
        value = decodeEntities(text);
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = vMatch ? vMatch[1] : '';
        if (type === 's') {
          const si = parseInt(raw, 10);
          value = shared[si] != null ? shared[si] : '';
        } else {
          value = decodeEntities(raw);
        }
      }
      if (idx >= 0) cells[idx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

function numericSuffix(name) {
  const m = /sheet(\d+)\.xml$/.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

// Read the FIRST worksheet of an .xlsx Buffer → array of row arrays.
function readXlsxFirstSheet(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const map = readEntries(buffer);
  const sharedXml = map['xl/sharedStrings.xml'] ? map['xl/sharedStrings.xml'].toString('utf8') : '';
  const shared = parseSharedStrings(sharedXml);
  const sheetFiles = Object.keys(map)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b));
  if (!sheetFiles.length) throw new Error('no worksheet found in xlsx');
  return parseSheet(map[sheetFiles[0]].toString('utf8'), shared);
}

module.exports = {
  readXlsxFirstSheet,
  // exported for testing
  readEntries,
  parseSharedStrings,
  parseSheet,
  colToIndex,
  decodeEntities,
};
