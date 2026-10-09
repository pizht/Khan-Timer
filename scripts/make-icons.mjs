#!/usr/bin/env node
/**
 * Generate the extension's PNG icons.
 *
 * Written with Node built-ins only (zlib for the DEFLATE stream, a small CRC32
 * table) so the project gains no image dependency. Output goes to
 * `public/icons/`, and the build copies `public/` into `dist/`.
 *
 * The mark is a navy rounded square with a white timer ring and hand, which
 * stays legible down to 16x16. Each pixel is 4x4 supersampled so the small
 * sizes are antialiased rather than jagged.
 */

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'icons');

const NAVY = [0x0b, 0x21, 0x4a];
const WHITE = [0xff, 0xff, 0xff];
const TRANSPARENT = [0, 0, 0, 0];
const SUPERSAMPLE = 4;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Distance-to-rect test: a rounded rect is the set of points within `rad` of the inner rect. */
function insideRoundedRect(u, v, rad) {
  const cx = clamp(u, rad, 1 - rad);
  const cy = clamp(v, rad, 1 - rad);
  return Math.hypot(u - cx, v - cy) <= rad;
}

/** Colour of one sample point, in normalised [0,1] coordinates. */
function sample(u, v) {
  const ROUND = 0.22;
  if (!insideRoundedRect(u, v, ROUND)) return TRANSPARENT;

  const cx = 0.5;
  const cy = 0.53;

  // Timer ring.
  const d = Math.hypot(u - cx, v - cy);
  const outer = 0.315;
  const inner = 0.228;
  if (d <= outer && d >= inner) return WHITE;

  // Minute hand pointing up.
  if (Math.abs(u - cx) <= 0.036 && v <= cy && v >= cy - 0.155) return WHITE;
  // Hour hand pointing right.
  if (Math.abs(v - cy) <= 0.036 && u >= cx && u <= cx + 0.115) return WHITE;

  return NAVY;
}

function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const v = (y + (sy + 0.5) / SUPERSAMPLE) / size;
          const c = sample(u, v);
          // Composite over transparent: premultiply so edges blend correctly.
          const alpha = c.length === 4 ? c[3] : 255;
          r += c[0] * (alpha / 255);
          g += c[1] * (alpha / 255);
          b += c[2] * (alpha / 255);
          a += alpha;
        }
      }
      const alpha = a / samples;
      const offset = (y * size + x) * 4;
      // Un-premultiply back to straight alpha.
      const scale = alpha > 0 ? 255 / alpha : 0;
      pixels[offset + 0] = clamp(Math.round((r / samples) * scale), 0, 255);
      pixels[offset + 1] = clamp(Math.round((g / samples) * scale), 0, 255);
      pixels[offset + 2] = clamp(Math.round((b / samples) * scale), 0, 255);
      pixels[offset + 3] = clamp(Math.round(alpha), 0, 255);
    }
  }
  return pixels;
}

/* ---------------- minimal PNG writer ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Raw scanlines, each prefixed with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = encodePng(size, renderRgba(size));
    const file = path.join(OUT_DIR, `icon${size}.png`);
    await writeFile(file, png);
    console.log(`[icons] ${path.relative(ROOT, file)}  ${png.length} bytes`);
  }
}

main().catch((error) => {
  console.error('[icons] failed:', error);
  process.exit(1);
});
