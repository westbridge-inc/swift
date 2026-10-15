/**
 * Shared image-upload validation. Uploads are only ever accepted as real
 * raster images (JPEG/PNG/WebP) — a spoofed Content-Type must not be able to
 * smuggle scripts/PDFs into publicly served folders.
 */

import { AppError } from './errors';

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Cheap magic-byte sniff so a spoofed Content-Type cannot smuggle non-images. */
export function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const webp =
    buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return jpeg || png || webp;
}

// ---------------------------------------------------------------------------
// [Row 108] THE PIXEL CAP. A 5 MB upload can declare a huge canvas (a
// decompression bomb, or a 100 MP camera mode) that every later decode must
// expand: the website's resizer, a reviewer's screen. The width and height
// are read from the image's own header (JPEG frame, PNG IHDR, WebP
// VP8/VP8L/VP8X) without decoding a pixel, and the storage seam refuses
// anything over about 40 megapixels. A header this cannot read is left to the
// magic-byte sniff and the size limit, as before.
// ---------------------------------------------------------------------------

export const MAX_IMAGE_PIXELS = 40_000_000;

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    let marker = buffer[at + 1]!;
    while (marker === 0xff && at + 2 < buffer.length) { at += 1; marker = buffer[at + 1]!; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data before any frame header
    const length = buffer.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (at + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  // 25 bytes hold the smallest header (lossless); a read past the end throws and reads as null.
  if (buffer.length < 25 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  const data = 20;
  if (chunk === 'VP8X') return { width: buffer.readUIntLE(data + 4, 3) + 1, height: buffer.readUIntLE(data + 7, 3) + 1 };
  if (chunk === 'VP8L') {
    if (buffer[data] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(data + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (buffer[data + 3] !== 0x9d || buffer[data + 4] !== 0x01 || buffer[data + 5] !== 0x2a) return null;
    return { width: buffer.readUInt16LE(data + 6) & 0x3fff, height: buffer.readUInt16LE(data + 8) & 0x3fff };
  }
  return null;
}

/** Width and height from the header alone; null when it cannot be read or the type is not a raster image. */
export function imageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    const found = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? jpegDimensions(buffer)
      : mimeType === 'image/png' ? pngDimensions(buffer)
        : mimeType === 'image/webp' ? webpDimensions(buffer)
          : null;
    return found && found.width > 0 && found.height > 0 ? found : null;
  } catch {
    return null;
  }
}

/** Refuses (413 IMAGE_TOO_LARGE) a photo whose header declares more than MAX_IMAGE_PIXELS. */
export function assertImageWithinPixelCap(buffer: Buffer, mimeType: string): void {
  const size = imageDimensions(buffer, mimeType);
  if (size && size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new AppError(413, 'IMAGE_TOO_LARGE', 'This photo is larger than 40 megapixels. Take it again or choose a smaller photo.');
  }
}

/**
 * Document sniff (security spec §6): verification uploads accept PDFs too —
 * the content must match one of the allowed formats, never just the header.
 */
export function looksLikeDocument(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'application/pdf') {
    return buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-';
  }
  return looksLikeImage(buffer);
}

// ---------------------------------------------------------------------------
// METADATA STRIPPING [S8/C4]
//
// Every photo Swift accepts arrives straight off a phone camera, and a phone
// camera writes EXIF: GPS latitude/longitude to five decimal places, the
// capture timestamp, the device model and often its serial number. Swift then
// stored those bytes verbatim and served them back. A vendor's menu photo
// published the kitchen's coordinates; a courier's proof-of-delivery photo
// published the customer's doorstep; a rider's verification selfie published
// where that rider lives.
//
// None of it is needed to render an image, so none of it is kept. This runs at
// the storage seam (every StorageProvider.upload), not at the call sites —
// there are seven of those today and the eighth would forget.
//
// Dependency-free on purpose: re-encoding through a native image library is
// the right way to also produce the WebP/thumbnail ladder, but it is a new
// native dependency in the API image and a separate decision. Dropping
// metadata segments is a container-level edit that needs no decoder, so the
// privacy fix does not have to wait for it.
//
// FAILS OPEN, DELIBERATELY. If a buffer will not parse, the ORIGINAL is
// returned rather than a guess. These inputs have already passed the
// magic-byte sniff above, so the unparseable set is tiny — and a mangled ID
// document stops a real person from working, which is worse than a retained
// tag on a file that is already private and encrypted at rest.
// ---------------------------------------------------------------------------

/** JPEG APPn segments that carry no rendering information.
 *  KEPT: APP0 (JFIF density), APP2 (ICC colour profile), APP14 (Adobe colour
 *  transform — dropping it renders CMYK/YCCK JPEGs with inverted colour). */
const JPEG_DROP_MARKERS = new Set([
  0xe1, // APP1  — EXIF and XMP. The GPS lives here.
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, // APP3–APP11 — maker notes
  0xec, // APP12 — Ducky / "picture info"
  0xed, // APP13 — IPTC / Photoshop resources (author, location, copyright)
  0xef, // APP15
  0xfe, // COM   — free-text comment
]);

/** PNG ancillary chunks carrying text or capture metadata. */
const PNG_DROP_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripJpeg(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null; // not on a segment boundary — refuse
    // Skip fill bytes (a legal run of 0xFF before a marker).
    let m = i + 1;
    while (m < buf.length && buf[m] === 0xff) m += 1;
    if (m >= buf.length) return null;
    const marker = buf[m]!;
    // Standalone markers (no length word): TEM and RST0–RST7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, m + 1));
      i = m + 1;
      continue;
    }
    if (marker === 0xd9) { out.push(buf.subarray(i)); return Buffer.concat(out); } // EOI
    if (marker === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out); } // SOS → entropy data to the end
    if (m + 2 >= buf.length) return null;
    const len = buf.readUInt16BE(m + 1);
    if (len < 2) return null;
    const end = m + 1 + len;
    if (end > buf.length) return null;
    if (!JPEG_DROP_MARKERS.has(marker)) out.push(buf.subarray(i, end));
    i = end;
  }
  return Buffer.concat(out);
}

function stripPng(buf: Buffer): Buffer | null {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len; // length + type + data + crc
    if (len > buf.length || end > buf.length) return null;
    if (!PNG_DROP_CHUNKS.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

function stripWebp(buf: Buffer): Buffer | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const declared = buf.readUInt32LE(4) + 8;
  const limit = Math.min(declared, buf.length);
  const body: Buffer[] = [];
  let i = 12;
  while (i + 8 <= limit) {
    const fourcc = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const padded = size + (size % 2); // RIFF chunks pad to an even length
    const end = i + 8 + padded;
    if (end > limit) return null;
    if (fourcc === 'EXIF' || fourcc === 'XMP ') { i = end; continue; }
    if (fourcc === 'VP8X' && size >= 1) {
      // VP8X advertises which optional chunks follow. Leave those flags set
      // after removing the chunks and a strict decoder looks for bytes that
      // are gone. Flags: ICC 0x20, ALPHA 0x10, EXIF 0x08, XMP 0x04, ANIM 0x02.
      const chunk = Buffer.from(buf.subarray(i, end));
      chunk[8] = chunk[8]! & ~0x0c;
      body.push(chunk);
      i = end;
      continue;
    }
    body.push(buf.subarray(i, end));
    i = end;
  }
  if (!body.length) return null;
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(payload.length + 4, 4); // size counts "WEBP" + chunks
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, payload]);
}

/**
 * Remove EXIF/XMP/IPTC and other non-rendering metadata from an image.
 *
 * Returns the input unchanged for non-image mime types (encrypted document
 * envelopes and PDFs travel through the same seam) and for anything that does
 * not parse. Never throws — an upload must not fail because a camera wrote an
 * unusual segment.
 */
export function stripImageMetadata(buffer: Buffer, mimeType: string): Buffer {
  try {
    let stripped: Buffer | null = null;
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') stripped = stripJpeg(buffer);
    else if (mimeType === 'image/png') stripped = stripPng(buffer);
    else if (mimeType === 'image/webp') stripped = stripWebp(buffer);
    // A stripper that grew the file got something wrong; keep the original.
    if (!stripped || stripped.length > buffer.length) return buffer;
    return stripped;
  } catch {
    return buffer;
  }
}
