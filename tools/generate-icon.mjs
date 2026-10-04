#!/usr/bin/env node
/**
 * Generates the watch app icon (1024x1024 PNG) with zero dependencies:
 * a deep-blue gradient tile with a terminal prompt glyph.
 *
 *   node tools/generate-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'watch', 'ZCodeRemote', 'Assets.xcassets', 'AppIcon.appiconset');

const SIZE = 1024;
const SS = 3; // supersampling factor for anti-aliasing
const N = SIZE * SS;

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Signed distance to a rounded rectangle centred at (cx, cy).
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

// Distance from point to a thick line segment.
function sdSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / len2);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const TOP = [22, 34, 66];      // deep navy
const BOTTOM = [8, 12, 26];    // near black
const GLOW = [64, 132, 255];   // blue glow
const GLYPH = [232, 246, 255]; // near-white
const ACCENT = [88, 214, 255]; // cyan

function sample(x, y) {
  // Normalized coords 0..1
  const u = x / N;
  const v = y / N;

  // Background: vertical gradient + radial glow from the upper-left
  let col = mix(TOP, BOTTOM, clamp01(v * 1.15));
  const gx = (u - 0.32) * 1.6;
  const gy = (v - 0.28) * 1.6;
  const glow = Math.exp(-(gx * gx + gy * gy) * 1.4) * 0.55;
  col = mix(col, GLOW, glow);

  // Subtle vignette
  const vig = 1 - 0.25 * Math.pow(Math.hypot(u - 0.5, v - 0.5) * 1.42, 2.2);
  col = [col[0] * vig, col[1] * vig, col[2] * vig];

  // Soft rounded frame highlight
  const frame = sdRoundRect(x, y, N / 2, N / 2, N * 0.44, N * 0.44, N * 0.22);
  const frameEdge = clamp01((frame + N * 0.012) / (N * 0.012));
  col = mix(col, GLYPH, 0.06 * frameEdge);

  // Glyph: a chevron ">" and an underscore, like a terminal prompt
  const stroke = N * 0.035;
  const a1 = sdSegment(x, y, N * 0.30, N * 0.34, N * 0.50, N * 0.50);
  const a2 = sdSegment(x, y, N * 0.50, N * 0.50, N * 0.30, N * 0.66);
  const chevron = Math.min(a1, a2) - stroke / 2;

  const bar = sdRoundRect(x, y, N * 0.635, N * 0.655, N * 0.145, stroke * 0.42, stroke * 0.42);

  const glyphDist = Math.min(chevron, bar);
  const glyphMask = clamp01(0.5 - glyphDist / (N * 0.004));
  if (glyphMask > 0) {
    const isBar = bar < chevron;
    col = mix(col, isBar ? ACCENT : GLYPH, glyphMask);
  }

  return col;
}

// Render with supersampling
const hi = new Float32Array(N * N * 3);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const c = sample(x + 0.5, y + 0.5);
    const i = (y * N + x) * 3;
    hi[i] = c[0];
    hi[i + 1] = c[1];
    hi[i + 2] = c[2];
  }
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
const s2 = SS * SS;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * N + (x * SS + dx)) * 3;
        r += hi[i];
        g += hi[i + 1];
        b += hi[i + 2];
      }
    }
    const o = (y * SIZE + x) * 4;
    rgba[o] = Math.round(clamp01(r / s2 / 255) * 255);
    rgba[o + 1] = Math.round(clamp01(g / s2 / 255) * 255);
    rgba[o + 2] = Math.round(clamp01(b / s2 / 255) * 255);
    rgba[o + 3] = 255;
  }
}

// --- minimal PNG encoder -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-1024.png'), png);

fs.writeFileSync(
  path.join(OUT, 'Contents.json'),
  JSON.stringify(
    {
      images: [{ filename: 'icon-1024.png', idiom: 'universal', platform: 'watchos', size: '1024x1024' }],
      info: { author: 'xcode', version: 1 },
    },
    null,
    2
  ) + '\n'
);

console.log(`wrote ${path.join(OUT, 'icon-1024.png')} (${(png.length / 1024).toFixed(1)} KB)`);
