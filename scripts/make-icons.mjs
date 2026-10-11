#!/usr/bin/env node
/**
 * Generate the extension's PNG icons from the project logo.
 *
 * Written with Node built-ins only (zlib for DEFLATE, a small CRC32 table) so
 * the project gains no image dependency. The source of truth is the square
 * logo at `assets/logo.png`; this script resamples it to 16/32/48/128 px.
 * Output goes to `public/icons/`, and the build copies `public/` into `dist/`.
 *
 * The source art is a full-bleed square: its blue field runs right up to all
 * four edges with square corners, so the icons ship as opaque squares with no
 * crop and no corner rounding. The previous logo was a rounded blue mark
 * floating on a near-white background, which this script used to detect, crop
 * and re-round; that geometry no longer applies, so `measureMark` now only
 * asserts that the source still is what the renderer assumes.
 *
 * Resampling is done once per target size with a Lanczos-3 filter over
 * premultiplied alpha, so the small sizes stay clean instead of aliasing.
 *
 * Run with `pnpm run icons` (or `npm run icons`).
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets', 'logo.png');
const OUT_DIR = path.join(ROOT, 'public', 'icons');
const SIZES = [16, 32, 48, 128];

/**
 * Blue-detection threshold: "clearly more blue than red", as in the source art.
 * Used only to confirm the source is still a full-bleed blue square.
 */
const BLUE_MARGIN = 40;
const BLUE_FLOOR = 100;
/** How many pixels deep the edge band is when checking the frame colour. */
const FRAME_BAND = 2;
/** Sub-pixel resolution of the precomputed resampling weights. */
const SUB_PIXELS = 64;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* ---------------- minimal PNG reader ---------------- */

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Read a PNG file into `{ width, height, rgba }` with straight (non-premultiplied) alpha. */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }

  let offset = 8;
  let header = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      header.palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      header.transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!header) throw new Error('PNG has no IHDR chunk');
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (header.depth !== 8) throw new Error(`unsupported bit depth ${header.depth} (expected 8)`);
  if (!CHANNELS[header.colorType]) throw new Error(`unsupported colour type ${header.colorType}`);

  const { width, height, colorType } = header;
  const channels = CHANNELS[colorType];
  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const raw = Buffer.alloc(stride * height);
  const bpp = channels;

  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = packed[cursor];
    cursor += 1;
    const line = packed.subarray(cursor, cursor + stride);
    cursor += stride;
    const out = raw.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[x - bpp] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= bpp ? prior[x - bpp] : 0;
      const value = line[x];
      let result;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filter}`);
      }
      out[x] = result & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) {
      r = g = b = raw[s];
    } else if (colorType === 2) {
      r = raw[s];
      g = raw[s + 1];
      b = raw[s + 2];
    } else if (colorType === 4) {
      r = g = b = raw[s];
      a = raw[s + 1];
    } else if (colorType === 6) {
      r = raw[s];
      g = raw[s + 1];
      b = raw[s + 2];
      a = raw[s + 3];
    } else {
      const index = raw[s];
      r = header.palette[index * 3];
      g = header.palette[index * 3 + 1];
      b = header.palette[index * 3 + 2];
      a = header.transparency && index < header.transparency.length ? header.transparency[index] : 255;
    }
    rgba[d] = r;
    rgba[d + 1] = g;
    rgba[d + 2] = b;
    rgba[d + 3] = a;
  }

  return { width, height, rgba };
}

/* ---------------- minimal PNG writer ---------------- */

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Raw scanlines, each prefixed with filter type 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- source geometry ---------------- */

const isBlue = (image, x, y) => {
  const i = (y * image.width + x) * 4;
  if (image.rgba[i + 3] < 8) return false;
  return image.rgba[i + 2] > image.rgba[i] + BLUE_MARGIN && image.rgba[i + 2] > BLUE_FLOOR;
};

/**
 * Confirm the source is what the renderer assumes: a square, full-bleed blue
 * plate whose blue reaches every edge, corners included.
 *
 * The icons are shipped as opaque squares, so a source that drifted back to
 * "a mark floating on a light background" (or gained rounded corners) would
 * otherwise silently ship a crop of somebody else's background. Failing loudly
 * keeps `pnpm run icons` honest.
 *
 * Returns the crop box (the whole image) so the renderer stays box-driven.
 */
function measureMark(image) {
  const { width, height } = image;
  if (width !== height) {
    throw new Error(`source logo must be square, got ${width}x${height}`);
  }

  const band = Math.min(FRAME_BAND, Math.floor((width - 1) / 2));
  const failures = [];
  const check = (x, y, where) => {
    if (!isBlue(image, x, y)) {
      const i = (y * width + x) * 4;
      failures.push(`${where} rgb(${image.rgba[i]}, ${image.rgba[i + 1]}, ${image.rgba[i + 2]})`);
    }
  };

  // Top and bottom bands, including all four corner pixels.
  for (let x = 0; x < width; x += 1) {
    for (let d = 0; d < band; d += 1) {
      check(x, d, `top edge y=${d}`);
      check(x, height - 1 - d, `bottom edge y=${height - 1 - d}`);
    }
  }
  // Left and right bands.
  for (let y = 0; y < height; y += 1) {
    for (let d = 0; d < band; d += 1) {
      check(d, y, `left edge x=${d}`);
      check(width - 1 - d, y, `right edge x=${width - 1 - d}`);
    }
  }

  if (failures.length > 0) {
    const shown = failures.slice(0, 3).join('; ');
    throw new Error(
      `source logo is not a full-bleed blue square: ${failures.length} edge pixels are not blue ` +
        `(${shown}${failures.length > 3 ? '; …' : ''})`,
    );
  }

  return {
    box: { x: 0, y: 0, width, height },
    markWidth: width,
    markHeight: height,
    // The plate colour, used as the backdrop partial alpha blends against.
    edgeColour: sampleEdgeColour(image),
  };
}

/** Median colour of the outermost ring, i.e. the logo's own background blue. */
function sampleEdgeColour(image) {
  const { width, height } = image;
  const channels = [[], [], []];
  const push = (x, y) => {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c += 1) channels[c].push(image.rgba[i + c]);
  };
  const step = Math.max(1, Math.floor(width / 128));
  for (let x = 0; x < width; x += step) {
    push(x, 0);
    push(x, height - 1);
    push(x, 1);
    push(x, height - 2);
  }
  for (let y = 0; y < height; y += step) {
    push(0, y);
    push(width - 1, y);
    push(1, y);
    push(width - 2, y);
  }
  return channels.map((values) => {
    const sorted = values.sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  });
}

/* ---------------- resampling ---------------- */

/**
 * Build the resampling filter for one axis: `scale` source pixels per output
 * pixel. Weights are precomputed at the fractional sub-pixel positions a
 * downscale can land on, then indexed by the fractional part of the output
 * pixel's source coordinate. A windowed sinc only rings when magnifying, so
 * `scale < 1` widens the kernel and normalises it back to a smooth average.
 */
function buildFilter(scale) {
  const support = 3;
  const blur = Math.max(1, 1 / scale);
  const taps = Math.ceil(support * blur) * 2 + 1;
  const table = new Float64Array(SUB_PIXELS * taps);

  for (let s = 0; s < SUB_PIXELS; s += 1) {
    const fraction = s / SUB_PIXELS;
    const weights = table.subarray(s * taps, (s + 1) * taps);
    let total = 0;
    for (let i = 0; i < taps; i += 1) {
      const w = lanczos((i - (taps - 1) / 2 + fraction) / blur);
      weights[i] = w;
      total += w;
    }
    if (total !== 0) {
      for (let i = 0; i < taps; i += 1) weights[i] /= total;
    } else {
      weights.fill(1 / taps);
    }
  }

  const firstTap = -(taps - 1) / 2;
  return {
    taps,
    table,
    /** Source offsets relative to the output pixel's first source pixel. */
    offset: (i) => firstTap + i,
    /** Normalised weights for the fractional source position `x`. */
    weightsFor(x) {
      const base = Math.floor(x);
      const s = clamp(Math.round((x - base) * SUB_PIXELS), 0, SUB_PIXELS - 1);
      return { base, weights: table.subarray(s * taps, (s + 1) * taps) };
    },
  };
}

function lanczos(t) {
  if (t === 0) return 1;
  const x = Math.abs(t);
  if (x >= 3) return 0;
  const pix = Math.PI * x;
  return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
}

/** Sample the source at a fractional pixel centre (edge-clamped), premultiplied. */
function samplePremultiplied(image, x, y, out) {
  const cx = clamp(Math.round(x), 0, image.width - 1);
  const cy = clamp(Math.round(y), 0, image.height - 1);
  const i = (cy * image.width + cx) * 4;
  const alpha = image.rgba[i + 3] / 255;
  out[0] = image.rgba[i] * alpha;
  out[1] = image.rgba[i + 1] * alpha;
  out[2] = image.rgba[i + 2] * alpha;
  out[3] = image.rgba[i + 3];
}

/**
 * Resample `box` from `image` into a fully opaque `size` x `size` RGBA buffer.
 *
 * The icons are opaque squares covering the whole tile: the source is a
 * full-bleed plate, so there is no background to crop away and no corner mask
 * to apply. Any partial alpha left by the resampler (there is none for an
 * opaque full-bleed source, but the math is shared) is composited onto the
 * plate colour rather than onto white, so an edge can never read as a light
 * fringe.
 */
function renderIcon(image, box, size, edgeColour) {
  const scaleX = box.width / size;
  const scaleY = box.height / size;
  const filterX = buildFilter(scaleX);
  const filterY = buildFilter(scaleY);
  const sample = [0, 0, 0, 0];
  const reach = ((filterY.taps - 1) / 2) * scaleY;

  // Only the source rows the vertical filter can reach are touched at all.
  const first = clamp(Math.floor(box.y - reach), 0, image.height - 1);
  const last = clamp(Math.ceil(box.y + size * scaleY + reach), 0, image.height - 1);
  const rows = last - first + 1;
  const columns = size;

  // Horizontal pass, from the reached source rows into `size` columns.
  const pass1 = new Float64Array(columns * rows * 4);
  for (let y = first; y <= last; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const { base, weights } = filterX.weightsFor(box.x + x * scaleX);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < filterX.taps; t += 1) {
        const w = weights[t];
        if (w === 0) continue;
        samplePremultiplied(image, base + filterX.offset(t), y, sample);
        r += sample[0] * w;
        g += sample[1] * w;
        b += sample[2] * w;
        a += sample[3] * w;
      }
      const o = ((y - first) * columns + x) * 4;
      pass1[o] = r;
      pass1[o + 1] = g;
      pass1[o + 2] = b;
      pass1[o + 3] = a;
    }
  }

  // Vertical pass into the final size x size buffer.
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const { base, weights } = filterY.weightsFor(box.y + y * scaleY);
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < filterY.taps; t += 1) {
        const w = weights[t];
        if (w === 0) continue;
        const sy = clamp(base + filterY.offset(t) - first, 0, rows - 1);
        const o = (sy * columns + x) * 4;
        r += pass1[o] * w;
        g += pass1[o + 1] * w;
        b += pass1[o + 2] * w;
        a += pass1[o + 3] * w;
      }

      const alpha = clamp(a, 0, 255) / 255;
      const normalise = alpha > 0 ? 1 / alpha : 0;
      const rr = clamp(r * normalise, 0, 255);
      const gg = clamp(g * normalise, 0, 255);
      const bb = clamp(b * normalise, 0, 255);

      // Straight alpha, composited onto the plate colour by (1 - alpha).
      const backdrop = 1 - alpha;
      const d = (y * size + x) * 4;
      rgba[d] = Math.round(rr + (edgeColour[0] - rr) * backdrop);
      rgba[d + 1] = Math.round(gg + (edgeColour[1] - gg) * backdrop);
      rgba[d + 2] = Math.round(bb + (edgeColour[2] - bb) * backdrop);
      rgba[d + 3] = 255;
    }
  }

  return rgba;
}

async function main() {
  const source = await readFile(SOURCE);
  const image = decodePng(source);
  const { box, markWidth, markHeight, edgeColour } = measureMark(image);

  console.log(
    `[icons] source ${path.relative(ROOT, SOURCE)} ${image.width}x${image.height}; ` +
      `plate ${markWidth}x${markHeight} at ${Math.round(box.x)},${Math.round(box.y)}; ` +
      `plate colour rgb(${edgeColour.join(', ')})`,
  );

  await mkdir(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size, size, renderIcon(image, box, size, edgeColour));
    const file = path.join(OUT_DIR, `icon${size}.png`);
    await writeFile(file, png);
    console.log(`[icons] ${path.relative(ROOT, file)}  ${png.length} bytes`);
  }
}

// Only generate when run directly, so the helpers stay importable for tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[icons] failed:', error);
    process.exit(1);
  });
}

export { decodePng, encodePng, measureMark, sampleEdgeColour, renderIcon, buildFilter };
