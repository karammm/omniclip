// Draws the OmniClip icon (a clipboard on an indigo tile) into PNGs for the PWA, the tray and the installers.
// Run: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const INDIGO = [79, 70, 229];
const VIOLET = [124, 58, 237];
const DARK = [49, 46, 129];
const WHITE = [255, 255, 255];

/**
 * style: 'tile' (rounded app icon), 'maskable' (full bleed, content in safe zone),
 * 'template' (black glyph on transparent, for the macOS menu bar), 'glyph' (white glyph, Windows tray)
 */
function sample(x, y, style) {
  const tile = style === 'tile' || style === 'maskable';
  let bg = null;
  if (style === 'maskable' || (style === 'tile' && inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22))) {
    const t = (x + y) / 2;
    bg = [...INDIGO.map((c, i) => c + (VIOLET[i] - c) * t), 255];
  }
  // scale glyph into the safe zone for maskable icons; enlarge it for tray glyphs
  const s = style === 'maskable' ? 0.78 : tile ? 1 : 1.25;
  const gx = (x - 0.5) / s + 0.5;
  const gy = (y - 0.5) / s + 0.52;

  const board = inRoundRect(gx, gy, 0.27, 0.22, 0.73, 0.84, 0.07);
  const boardInner = inRoundRect(gx, gy, 0.34, 0.29, 0.66, 0.77, 0.03);
  const clip = inRoundRect(gx, gy, 0.37, 0.14, 0.63, 0.3, 0.045);
  const line = inRoundRect(gx, gy, 0.37, 0.43, 0.63, 0.49, 0.03) || inRoundRect(gx, gy, 0.37, 0.57, 0.55, 0.63, 0.03);

  if (tile) {
    if (clip) return [...DARK, 255];
    if (board && line) return [...INDIGO, 255];
    if (board) return [...WHITE, 255];
    return bg ?? [0, 0, 0, 0];
  }
  const ink = style === 'template' ? [0, 0, 0] : WHITE;
  if (clip || line || (board && !boardInner)) return [...ink, 255];
  return [0, 0, 0, 0];
}

function render(size, style) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, style);
          const a = c[3] / 255;
          acc[0] += c[0] * a;
          acc[1] += c[1] * a;
          acc[2] += c[2] * a;
          acc[3] += a;
        }
      }
      const o = (py * size + px) * 4;
      const a = acc[3];
      out[o] = a ? Math.round(acc[0] / a) : 0;
      out[o + 1] = a ? Math.round(acc[1] / a) : 0;
      out[o + 2] = a ? Math.round(acc[2] / a) : 0;
      out[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return encodePng(size, out);
}

const targets = [
  ['apps/web/public/icons/icon-192.png', 192, 'tile'],
  ['apps/web/public/icons/icon-512.png', 512, 'tile'],
  ['apps/web/public/icons/maskable-512.png', 512, 'maskable'],
  ['apps/web/public/icons/apple-touch-icon.png', 180, 'maskable'],
  ['apps/web/public/favicon.png', 32, 'tile'],
  ['apps/desktop/assets/icon.png', 1024, 'tile'],
  ['apps/desktop/assets/trayTemplate.png', 16, 'template'],
  ['apps/desktop/assets/trayTemplate@2x.png', 32, 'template'],
  ['apps/desktop/assets/tray-win.png', 32, 'glyph'],
];

for (const [file, size, style] of targets) {
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, render(size, style));
  console.log(`wrote ${file}`);
}
