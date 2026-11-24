/**
 * Generates the PNG app icons (favicon / manifest) from the same flat
 * geometry as public/icon.svg — no image deps, just zlib + a tiny PNG
 * encoder. Run: `node scripts/gen-icons.mjs` (writes public/icon-*.png).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// icon.svg geometry in its 64×64 viewBox.
const BG = '#181a1b';
const LIME = '#c6f54e';
const SS = 4; // supersampling factor for antialiasing

function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
const BG_RGB = hexRgb(BG);
const LIME_RGB = hexRgb(LIME);

/** Signed distance to a rounded box centred at (cx,cy), half-size (hx,hy), corner r. */
function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// Background: full-canvas rounded rect, radius 12.
const bgInside = (x, y) => sdRoundBox(x, y, 32, 32, 32, 32, 12) <= 0;
// Keyboard outline: rect x10 y18 w44 h28 rx5, stroke width 3 → |sd| ≤ 1.5.
const outline = (x, y) => {
  const d = sdRoundBox(x, y, 32, 32, 22, 14, 5);
  return d >= -1.5 && d <= 1.5;
};
// Key caps: [x, y, w, h, opacity] in viewBox units (rx 1 ≈ negligible, use 1).
const KEYS = [
  [16, 24, 6, 6, 1],
  [26, 24, 6, 6, 1],
  [36, 24, 6, 6, 1],
  [46, 24, 6, 6, 0.35],
  [16, 34, 6, 6, 0.35],
  [26, 34, 6, 6, 0.35],
  [36, 34, 6, 6, 0.35],
  [46, 34, 12, 6, 1],
];
const keyAt = (x, y) => {
  for (const [kx, ky, kw, kh, op] of KEYS) {
    if (sdRoundBox(x, y, kx + kw / 2, ky + kh / 2, kw / 2, kh / 2, 1) <= 0) return op;
  }
  return 0;
};

/** Colour at one viewBox-space point → [r,g,b,a] 0..255. */
function sample(x, y) {
  const op = keyAt(x, y) || (outline(x, y) ? 1 : 0);
  if (!bgInside(x, y)) {
    // Only the (never-hit) case of art outside the rounded bg.
    return op > 0 ? [...LIME_RGB, Math.round(255 * op)] : [0, 0, 0, 0];
  }
  if (op <= 0) return [...BG_RGB, 255];
  return [
    Math.round(BG_RGB[0] + (LIME_RGB[0] - BG_RGB[0]) * op),
    Math.round(BG_RGB[1] + (LIME_RGB[1] - BG_RGB[1]) * op),
    Math.round(BG_RGB[2] + (LIME_RGB[2] - BG_RGB[2]) * op),
    255,
  ];
}

/** Rasterise to `size`×`size` RGBA. */
function render(size) {
  const scale = size / 64;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / scale;
          const y = (py + (sy + 0.5) / SS) / scale;
          const [sr, sg, sb, sa] = sample(x, y);
          r += sr; g += sg; b += sb; a += sa;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ── Minimal PNG encoder (truecolour+alpha, filter 0) ───────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [32, 192, 512]) {
  const png = encodePng(size, render(size));
  const file = join(ROOT, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
