import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripImageMetadata } from '../utils/images';
import { LocalStorageProvider } from '../providers/storage/storage-provider';

// ---------------------------------------------------------------------------
// [S8/C4] Uploads arrive straight off a phone camera and carry EXIF: GPS to
// five decimals, capture time, device serial. Swift stored those bytes and
// served them back — a vendor's menu photo published the kitchen's
// coordinates, a courier's proof photo the customer's doorstep.
//
// The strong assertion in this file is EQUALITY WITH THE ORIGINAL IMAGE:
// each fixture is a real 1×1 image with a metadata segment INSERTED, so a
// correct strip must return the untouched original byte for byte. That grades
// both halves at once — the metadata is gone AND no pixel was disturbed.
// ---------------------------------------------------------------------------

/** A real 1×1 JPEG (SOI…EOI, full quant/Huffman tables and scan data). */
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

/** A real 1×1 PNG: IHDR, IDAT, IEND. */
const BASE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA3fxQ8AAAAABJRU5ErkJggg==',
  'base64',
);

/** The coordinates a real camera would have written. If this string survives
 *  a strip, the fix does not work. */
const GPS_NEEDLE = 'GPS 6.80448,-58.15527 IMG_0421 SN:F17XR0J2HG7K';

/** Splice an APP1 EXIF segment in immediately after SOI, where a camera puts it. */
function jpegWithExif(): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), Buffer.from(GPS_NEEDLE, 'ascii')]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
  return Buffer.concat([BASE_JPEG.subarray(0, 2), app1, BASE_JPEG.subarray(2)]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  // CRC is not validated by the stripper (it copies or drops whole chunks), so
  // a fixed placeholder keeps the fixture readable.
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

/** Splice tEXt + eXIf in after IHDR (offset 8 + 12 + 13). */
function pngWithMetadata(): Buffer {
  const afterIhdr = 8 + 12 + 13;
  const extra = Buffer.concat([
    pngChunk('tEXt', Buffer.from(`Comment\0${GPS_NEEDLE}`, 'ascii')),
    pngChunk('eXIf', Buffer.from(GPS_NEEDLE, 'ascii')),
  ]);
  return Buffer.concat([BASE_PNG.subarray(0, afterIhdr), extra, BASE_PNG.subarray(afterIhdr)]);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, 'ascii'), size, data, pad]);
}

/** An extended WebP whose VP8X advertises EXIF (0x08) and XMP (0x04). */
function webpWithExif(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF + XMP + ALPHA
  const body = Buffer.concat([
    riffChunk('VP8X', vp8x),
    riffChunk('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0x08])),
    riffChunk('EXIF', Buffer.from(GPS_NEEDLE, 'ascii')),
    riffChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'ascii')),
  ]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

describe('stripImageMetadata — the camera metadata never reaches storage', () => {
  it('JPEG: the EXIF segment is removed and the image is returned byte-identical', () => {
    const dirty = jpegWithExif();
    expect(dirty.includes(GPS_NEEDLE)).toBe(true);
    expect(dirty.length).toBeGreaterThan(BASE_JPEG.length);

    const clean = stripImageMetadata(dirty, 'image/jpeg');

    expect(clean.includes(GPS_NEEDLE)).toBe(false);
    expect(clean.includes('Exif')).toBe(false);
    // The whole point: everything that is not metadata survives untouched.
    expect(clean.equals(BASE_JPEG)).toBe(true);
  });

  it('JPEG: a clean image is left exactly as it is (no re-encode, no loss)', () => {
    expect(stripImageMetadata(BASE_JPEG, 'image/jpeg').equals(BASE_JPEG)).toBe(true);
  });

  it('PNG: tEXt and eXIf are dropped, IHDR/IDAT/IEND survive byte-identical', () => {
    const dirty = pngWithMetadata();
    expect(dirty.includes(GPS_NEEDLE)).toBe(true);

    const clean = stripImageMetadata(dirty, 'image/png');

    expect(clean.includes(GPS_NEEDLE)).toBe(false);
    expect(clean.equals(BASE_PNG)).toBe(true);
  });

  it('WebP: EXIF and XMP chunks go, and VP8X stops advertising them', () => {
    const dirty = webpWithExif();
    expect(dirty.includes(GPS_NEEDLE)).toBe(true);

    const clean = stripImageMetadata(dirty, 'image/webp');

    expect(clean.includes(GPS_NEEDLE)).toBe(false);
    expect(clean.toString('ascii')).not.toContain('XMP ');
    // Container stays well-formed: RIFF size must match the real payload, or a
    // decoder reads past the end.
    expect(clean.toString('ascii', 0, 4)).toBe('RIFF');
    expect(clean.readUInt32LE(4)).toBe(clean.length - 8);
    // VP8X flag byte: ALPHA (0x10) kept, EXIF (0x08) and XMP (0x04) cleared.
    const flags = clean[20]!;
    expect(flags & 0x08).toBe(0);
    expect(flags & 0x04).toBe(0);
    expect(flags & 0x10).toBe(0x10);
    // The actual image chunk is still there.
    expect(clean.toString('ascii')).toContain('VP8L');
  });

  it('is idempotent — stripping twice changes nothing', () => {
    const once = stripImageMetadata(jpegWithExif(), 'image/jpeg');
    expect(stripImageMetadata(once, 'image/jpeg').equals(once)).toBe(true);
  });

  it('leaves non-images alone: a PDF and an encrypted envelope pass through untouched', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(64, 9)]);
    expect(stripImageMetadata(pdf, 'application/pdf').equals(pdf)).toBe(true);
    const envelope = Buffer.alloc(128, 0xab);
    expect(stripImageMetadata(envelope, 'application/octet-stream').equals(envelope)).toBe(true);
  });

  it('FAILS OPEN: unparseable bytes claiming to be an image come back unchanged, never a throw', () => {
    const junk = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
    expect(() => stripImageMetadata(junk, 'image/jpeg')).not.toThrow();
    expect(stripImageMetadata(junk, 'image/jpeg').equals(junk)).toBe(true);
    const truncated = BASE_PNG.subarray(0, 20);
    expect(stripImageMetadata(truncated, 'image/png').equals(truncated)).toBe(true);
  });
});

describe('the storage seam strips before anything is written', () => {
  let dir: string;
  let previous: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'swift-strip-'));
    previous = process.env['UPLOAD_DIR'];
    process.env['UPLOAD_DIR'] = dir;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env['UPLOAD_DIR'];
    else process.env['UPLOAD_DIR'] = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('a photo uploaded with GPS lands on disk without it', async () => {
    const storage = new LocalStorageProvider();
    const { url } = await storage.upload({
      buffer: jpegWithExif(),
      filename: 'IMG_0421.jpg',
      mimeType: 'image/jpeg',
      folder: 'verification',
    });

    const onDisk = await readFile(path.join(dir, url.replace(/^\/uploads\//, '')));
    expect(onDisk.includes(GPS_NEEDLE)).toBe(false);
    expect(onDisk.equals(BASE_JPEG)).toBe(true);
  });

  it('a PDF document is stored byte-identical — the seam must not touch it', async () => {
    const storage = new LocalStorageProvider();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(256, 3)]);
    const { url } = await storage.upload({
      buffer: pdf,
      filename: 'licence.pdf',
      mimeType: 'application/pdf',
      folder: 'verification',
    });

    const onDisk = await readFile(path.join(dir, url.replace(/^\/uploads\//, '')));
    expect(onDisk.equals(pdf)).toBe(true);
  });
});
