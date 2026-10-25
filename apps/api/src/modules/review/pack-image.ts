/**
 * [STA-1 Part 6] The review content pack's pictures: drawn by this file, from
 * the pack's own words, at the moment they are asked for.
 *
 * LICENCE / SOURCE: every pixel is generated here — a solid colour, Swift's
 * own 5x7 pixel lettering (authored in this file), and the name of a
 * fictional store or item from content-pack.ts. No photograph, no stock
 * library, no font file, no download, no third party. Swift owns the output.
 *
 * WHY RENDERED, NOT STORED: the pack is seeded by an operator command that may
 * run in a different container from the API that serves uploads, and a
 * stored file would vanish on the next redeploy of a container without an
 * uploads volume. A picture computed from the code itself is the same bytes in
 * every process, survives every deploy and needs no storage. Only names the
 * pack declares can be drawn: anything else is a 404, never a render.
 */
import zlib from 'node:zlib';

export const PACK_IMAGE_WIDTH = 640;
export const PACK_IMAGE_HEIGHT = 480;

/** Swift's own 5x7 lettering: seven rows of five bits per glyph (bit 4 = left). */
const GLYPHS: Record<string, readonly number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  "'": [0x04, 0x04, 0x08, 0, 0, 0, 0],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  '/': [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
};

/** True when every character of `text` can be lettered (case-insensitive). */
export function isLetterable(text: string): boolean {
  return [...text.toUpperCase()].every((ch) => ch in GLYPHS);
}

type Rgb = readonly [number, number, number];

/** "#rrggbb" → [r, g, b]; refuses anything else so a typo is loud, not black. */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

const shade = ([r, g, b]: Rgb, f: number): Rgb => [Math.round(r * f), Math.round(g * f), Math.round(b * f)];

/** Greedy word wrap to `max` characters; a word longer than a line is split. */
export function wrapWords(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const raw of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    let word = raw;
    while (word.length > max) {
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line = `${line} ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

class Canvas {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: Rgb) {
    this.px = new Uint8Array(w * h * 3);
    this.fill(0, 0, w, h, bg);
  }
  fill(x0: number, y0: number, w: number, h: number, [r, g, b]: Rgb): void {
    const x1 = Math.min(this.w, x0 + w);
    const y1 = Math.min(this.h, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      for (let x = Math.max(0, x0); x < x1; x++) {
        const i = (y * this.w + x) * 3;
        this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b;
      }
    }
  }
  /** One line of lettering, centred on `cx`, top at `y`, `scale` px per dot. */
  text(line: string, cx: number, y: number, scale: number, ink: Rgb): void {
    const advance = 6 * scale;
    const width = line.length * advance - scale;
    let x = Math.round(cx - width / 2);
    for (const ch of line) {
      const rows = GLYPHS[ch] ?? GLYPHS[' ']!;
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (rows[row]! & (0x10 >> col)) this.fill(x + col * scale, y + row * scale, scale, scale, ink);
        }
      }
      x += advance;
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** A truecolour, non-interlaced PNG of the canvas — no alpha, no metadata. */
function encodePng(c: Canvas): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(c.w, 0);
  header.writeUInt32BE(c.h, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  header[10] = 0; header[11] = 0; header[12] = 0;
  const stride = c.w * 3;
  const raw = Buffer.alloc((stride + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(c.px.buffer, c.px.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface PackPicture {
  /** The large words in the middle: the item's (or store's) own name. */
  title: string;
  /** The small words on the footer band: the store's name. */
  caption: string;
  /** The store's colour, "#rrggbb". */
  background: string;
}

const TITLE_SCALE = 5;
const TITLE_MAX_CHARS = 14; // 14 × 30 px fits the middle 420 px, so a square crop keeps every letter
const TITLE_MAX_LINES = 3;
const CAPTION_SCALE = 2;
const CAPTION_MAX_CHARS = 48;
const FOOTER_HEIGHT = 56;

/** Draws one picture. Refuses words it cannot letter, rather than drop them. */
export function renderPackPicture(p: PackPicture): Buffer {
  if (!isLetterable(p.title) || !isLetterable(p.caption)) throw new Error(`cannot letter "${p.title}" / "${p.caption}"`);
  const bg = parseHex(p.background);
  const ink: Rgb = [255, 255, 255];
  const c = new Canvas(PACK_IMAGE_WIDTH, PACK_IMAGE_HEIGHT, bg);
  const lines = wrapWords(p.title, TITLE_MAX_CHARS).slice(0, TITLE_MAX_LINES);
  const lineHeight = 7 * TITLE_SCALE + 3 * TITLE_SCALE;
  const blockHeight = lines.length * lineHeight - 3 * TITLE_SCALE;
  const top = Math.round((PACK_IMAGE_HEIGHT - FOOTER_HEIGHT - blockHeight) / 2);
  lines.forEach((line, i) => c.text(line, PACK_IMAGE_WIDTH / 2, top + i * lineHeight, TITLE_SCALE, ink));
  c.fill(0, PACK_IMAGE_HEIGHT - FOOTER_HEIGHT, PACK_IMAGE_WIDTH, FOOTER_HEIGHT, shade(bg, 0.72));
  const caption = p.caption.toUpperCase().slice(0, CAPTION_MAX_CHARS);
  c.text(caption, PACK_IMAGE_WIDTH / 2, PACK_IMAGE_HEIGHT - FOOTER_HEIGHT + Math.round((FOOTER_HEIGHT - 7 * CAPTION_SCALE) / 2), CAPTION_SCALE, ink);
  return encodePng(c);
}
