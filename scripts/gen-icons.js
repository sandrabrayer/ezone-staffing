#!/usr/bin/env node
/* Generate the PWA home-screen icons: a bold geometric letter "E" in white on
 * the E-ZONE green (#0F634F — the green disc of public/emblem.png).
 *
 * Same recipe as the therapists app's icon generator: the "E" is drawn from
 * scratch as a spine + three arms (stroke ~18.5% of the canvas, glyph ~65–70%
 * of the canvas, centred), anti-aliased by 4×4 supersampling, and encoded as
 * opaque truecolor PNGs by hand with Node's built-in zlib — no dependencies.
 *
 * Outputs (all referenced by public/manifest.webmanifest / index.html):
 *   public/icons/icon-192.png           192×192  purpose "any"
 *   public/icons/icon-512.png           512×512  purpose "any"
 *   public/icons/icon-maskable-512.png  512×512  purpose "maskable" — glyph
 *                                        scaled to 0.82 so the whole letter
 *                                        sits inside the central 80% safe zone
 *   public/icons/apple-touch-icon.png   180×180  iOS home screen
 *
 * Deterministic: re-running produces byte-identical files.
 * Run:  node scripts/gen-icons.js
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BG = [0x0f, 0x63, 0x4f];   // #0F634F — E-ZONE green
const INK = [0xff, 0xff, 0xff];  // white letter
const SS = 4;                    // 4×4 supersampling

// ---- PNG encode ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolor (opaque)
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the glyph -------------------------------------------------------------

// The "E" in unit coordinates (0..1 of the canvas) at scale 1: a spine and
// three arms, the middle arm slightly shorter. `scale` shrinks it about the
// centre (the maskable icon uses 0.82).
function glyphRects(scale) {
  const stroke = 0.185;
  const h = 0.68;             // glyph height
  const w = 0.50;             // glyph width (top/bottom arms)
  const mid = 0.42;           // middle arm width
  const x0 = 0.5 - w / 2;
  const y0 = 0.5 - h / 2;
  const rects = [
    [x0, y0, stroke, h],                                  // spine
    [x0, y0, w, stroke],                                  // top arm
    [x0, 0.5 - stroke / 2, mid, stroke],                  // middle arm
    [x0, y0 + h - stroke, w, stroke],                     // bottom arm
  ];
  return rects.map(([x, y, rw, rh]) => [
    0.5 + (x - 0.5) * scale, 0.5 + (y - 0.5) * scale, rw * scale, rh * scale,
  ]);
}

function render(size, scale) {
  const rects = glyphRects(scale).map(([x, y, w, h]) => [x * size, y * size, (x + w) * size, (y + h) * size]);
  const rgb = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + (sx + 0.5) / SS;
          const fy = py + (sy + 0.5) / SS;
          for (const [x1, y1, x2, y2] of rects) {
            if (fx >= x1 && fx < x2 && fy >= y1 && fy < y2) { hits++; break; }
          }
        }
      }
      const t = hits / (SS * SS);
      const o = (py * size + px) * 3;
      for (let c = 0; c < 3; c++) rgb[o + c] = Math.round(BG[c] + (INK[c] - BG[c]) * t);
    }
  }
  return encodePNG(size, size, rgb);
}

const OUTPUTS = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.82 },
  { file: 'apple-touch-icon.png', size: 180, scale: 1 },
];

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'public', 'icons');
  fs.mkdirSync(dir, { recursive: true });
  for (const o of OUTPUTS) {
    fs.writeFileSync(path.join(dir, o.file), render(o.size, o.scale));
    console.log('wrote public/icons/' + o.file);
  }
}

module.exports = { render, glyphRects, OUTPUTS, BG, INK };
