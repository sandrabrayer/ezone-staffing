'use strict';

// ---------------------------------------------------------------------------
// Minimal .xlsx WRITER — the mirror image of lib/xlsx_read.js.
//
// Same reasoning as the reader: the popular `xlsx` package carries unpatched
// advisories and this repo stays dependency-light. An .xlsx is a ZIP of XML
// parts, so writing one is a CRC32, a STORED-only ZIP container and four
// small XML documents.
//
// Scope: one worksheet of inline strings and numbers, which is exactly what
// the בקרת שכר export needs. No styles, formulas, dates or multiple sheets.
// STORED means no compression — a 93-row payroll sheet is a few tens of KB,
// and not shipping a deflate implementation is worth more than the bytes.
//
// Runs in BOTH Node and the browser: everything is Uint8Array, never Buffer.
// tests/payroll-export.test.js round-trips real output back through
// lib/xlsx_read.js, so the two stay honest about each other.
// ---------------------------------------------------------------------------

const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0 ^ (-1);
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

function utf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  return new Uint8Array(Buffer.from(str, 'utf8'));
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters outright; drop rather than
    // emit a file Excel refuses to open.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

// ---------------------------------------------------------------------------
// ZIP container (STORED, no compression)
// ---------------------------------------------------------------------------

function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  entries.forEach(function (entry) {
    const nameBytes = utf8(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    // Bit 11 of the general-purpose flags declares UTF-8 names.
    const header = []
      .concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
    local.push(new Uint8Array(header), nameBytes, data);
    central.push(new Uint8Array([]
      .concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))),
      nameBytes);
    offset += header.length + nameBytes.length + data.length;
  });

  const centralFlat = flatten(central);
  const eocd = new Uint8Array([]
    .concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(centralFlat.length), u32(offset), u16(0)));
  return flatten(local.concat([centralFlat, eocd]));
}

function flatten(chunks) {
  let total = 0;
  chunks.forEach(function (c) { total += c.length; });
  const out = new Uint8Array(total);
  let at = 0;
  chunks.forEach(function (c) { out.set(c, at); at += c.length; });
  return out;
}

// ---------------------------------------------------------------------------
// Sheet XML
// ---------------------------------------------------------------------------

function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(value, ref) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && isFinite(value)) {
    return '<c r="' + ref + '"><v>' + value + '</v></c>';
  }
  // Inline strings: no sharedStrings part to keep in sync, and the reader
  // resolves them the same way.
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
    escapeXml(value) + '</t></is></c>';
}

function sheetXml(rows) {
  const body = rows.map(function (row, r) {
    const cells = (row || []).map(function (v, c) {
      return cellXml(v, colName(c) + (r + 1));
    }).join('');
    return '<row r="' + (r + 1) + '">' + cells + '</row>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + body + '</sheetData></worksheet>';
}

// Build a one-sheet .xlsx from an array of rows of strings / numbers.
// Returns a Uint8Array.
function writeXlsx(rows, sheetName) {
  const name = escapeXml(String(sheetName || 'Sheet1').slice(0, 31)) || 'Sheet1';
  const parts = [
    {
      name: '[Content_Types].xml',
      xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', xml: sheetXml(rows || []) },
  ];
  return zip(parts.map(function (p) { return { name: p.name, data: utf8(p.xml) }; }));
}

const xlsxWriteApi = { writeXlsx: writeXlsx, crc32: crc32, colName: colName, escapeXml: escapeXml };

if (typeof module !== 'undefined' && module.exports) module.exports = xlsxWriteApi;
if (typeof window !== 'undefined') window.XlsxWrite = xlsxWriteApi;
