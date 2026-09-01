/**
 * Deterministic character-sheet variant generator (spec PAPERCLIP_PIXELS-2,
 * WS3 catalog expansion; NFR-3 licensing).
 *
 * Expands the character catalog beyond the 6 bundled CC0 MetroCity-derived
 * sheets by emitting hue-rotated derivatives of those sheets. The inputs are
 * CC0-1.0, so deterministic derivatives are licensing-safe and count as
 * "generated" sheets; no third-party (e.g. Agent-Pixels) code or sprites are
 * involved — only the *pattern* (ordered catalog + integer palette index +
 * per-agent assignment map) is adopted from Agent-Pixels.
 *
 * Output invariants (relied on by the catalog and the relay's asset-share
 * directory):
 *   - `char_<N>.png` for N in [6, BUNDLED_CHARACTERS + VARIANTS_PER_SHEET * 6)
 *   - byte-identical output for identical input (deterministic: fixed hue
 *     offsets, no RNG, fixed zlib level)
 *   - same geometry as the base sheets (112x96, 3 direction rows x 7 frames
 *     of 16x32), so Pixel Agents' unchanged `decodeCharacterPng` loads them
 *   - the sheet's integer palette index equals its filename index N: bundled
 *     sheets occupy 0..5 in Pixel Agents' merged sprite array and the relay
 *     shares exactly the N >= 6 sheets through the (privilege-gated)
 *     external-asset-directory path, which appends them in numeric order.
 *
 * Dependency-free on purpose: PNG decode/encode here is limited to the exact
 * shape the bundled sheets use (8-bit RGBA, non-interlaced, single IDAT).
 *
 * Run: node scripts/generate-character-variants.mjs
 */

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const charactersDir = path.resolve(__dirname, "..", "assets", "characters");

/** Pixel Agents' bundled sheet count (fork core CHAR_COUNT). */
export const BUNDLED_CHARACTERS = 6;
/** Hue rotations applied per base sheet. Coprime-ish spread keeps variants of
 * the same base sheet visually distinct from each other and from the base. */
const HUE_OFFSETS_DEG = [50, 140, 230];

// ── Minimal PNG codec (8-bit RGBA, non-interlaced) ──────────────────────────

function parsePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("not a PNG file");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`expected 8-bit RGBA (colorType 6), got depth ${bitDepth} type ${colorType}`);
  }
  const raw = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);
  let inOffset = 0;
  let previous = null;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[inOffset];
    inOffset += 1;
    const row = raw.subarray(inOffset, inOffset + stride);
    inOffset += stride;
    unfilterRow(filter, row, previous, stride, bytesPerPixel);
    row.copy(pixels, y * stride);
    previous = row;
  }
  return { width, height, pixels };
}

function unfilterRow(filter, row, previous, stride, bpp) {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < stride; i += 1) row[i] = (row[i] + row[i - bpp]) & 0xff;
      return;
    case 2:
      if (previous) for (let i = 0; i < stride; i += 1) row[i] = (row[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = previous ? previous[i] : 0;
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
      }
      return;
    case 4: {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = previous ? previous[i] : 0;
        const upLeft = previous && i >= bpp ? previous[i - bpp] : 0;
        row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    }
    default:
      throw new Error(`unknown PNG filter ${filter}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function crc32(buffer) {
  // Standard PNG CRC table, computed on first use.
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none (deterministic, size irrelevant)
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Hue rotation (RGB <-> HSL, alpha preserved) ─────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
}

function rotateHue(pixels, offsetDeg) {
  const out = Buffer.from(pixels);
  const offset = ((offsetDeg % 360) + 360) % 360 / 360;
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue; // fully transparent: leave untouched
    const [h, s, l] = rgbToHsl(out[i], out[i + 1], out[i + 2]);
    const [r, g, b] = hslToRgb((h + offset) % 1, s, l);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }
  return out;
}

// ── Variant generation ──────────────────────────────────────────────────────

function main() {
  const bases = [];
  for (let i = 0; i < BUNDLED_CHARACTERS; i += 1) {
    bases.push(parsePng(readFileSync(path.join(charactersDir, `char_${i}.png`))));
  }
  const generated = [];
  let nextIndex = BUNDLED_CHARACTERS;
  for (let baseIndex = 0; baseIndex < bases.length; baseIndex += 1) {
    for (const offset of HUE_OFFSETS_DEG) {
      const png = encodePng({
        width: bases[baseIndex].width,
        height: bases[baseIndex].height,
        pixels: rotateHue(bases[baseIndex].pixels, offset),
      });
      const file = `char_${nextIndex}.png`;
      writeFileSync(path.join(charactersDir, file), png);
      generated.push({
        index: nextIndex,
        baseIndex,
        offset,
        file,
      });
      nextIndex += 1;
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        generated: generated.length,
        firstIndex: BUNDLED_CHARACTERS,
        lastIndex: nextIndex - 1,
        entries: generated.map((g) => ({
          file: g.file,
          source: `char_${g.baseIndex}.png`,
          hueShiftDeg: g.offset,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
