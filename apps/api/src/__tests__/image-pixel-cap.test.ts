import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_IMAGE_PIXELS, assertImageWithinPixelCap, imageDimensions } from '../utils/images';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { AppError } from '../utils/errors';

// ---------------------------------------------------------------------------
// [Row 108] A photo's pixel count is capped at ~40 megapixels before it is stored.
//
// A 5 MB upload can declare a huge canvas (a decompression bomb, or a 100 MP
// camera mode) that every later decode (the website's resizer, a reviewer's
// screen) must expand. The API reads the width and height from the image's own
// header (JPEG frame, PNG IHDR, WebP VP8/VP8L/VP8X), never decoding pixels, and
// refuses anything over the cap at the one storage seam every photo passes
// through. A header it cannot read is left to the existing checks.
// ---------------------------------------------------------------------------

/** A real 1×1 PNG (the same fixture as image-metadata-strip). */
const BASE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA3fxQ8AAAAABJRU5ErkJggg==', 'base64');
/** A real 1×1 JPEG. */
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);

/** The PNG with its IHDR declaring width × height (bytes 16–23). */
function png(width: number, height: number): Buffer {
  const out = Buffer.from(BASE_PNG);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}
/** The JPEG with its baseline frame (SOF0) declaring width × height. */
function jpeg(width: number, height: number): Buffer {
  const out = Buffer.from(BASE_JPEG);
  const sof = out.indexOf(Buffer.from([0xff, 0xc0]));
  out.writeUInt16BE(height, sof + 5);
  out.writeUInt16BE(width, sof + 7);
  return out;
}
function riff(chunk: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  const body = Buffer.concat([Buffer.from(chunk, 'ascii'), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}
/** Extended WebP: the canvas is width-1 / height-1 as 24-bit little-endian. */
function webpVp8x(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', data);
}
/** Lossless WebP: signature 0x2f, then width-1 and height-1 as 14-bit fields. */
function webpVp8l(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(bits >>> 0, 1);
  return riff('VP8L', data);
}
/** Lossy WebP: frame tag, start code 9d 01 2a, then 14-bit width and height. */
function webpVp8(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[3] = 0x9d; data[4] = 0x01; data[5] = 0x2a;
  data.writeUInt16LE(width & 0x3fff, 6);
  data.writeUInt16LE(height & 0x3fff, 8);
  return riff('VP8 ', data);
}

describe('[row 108] image dimensions from the header alone', () => {
  it('reads PNG, JPEG and the three WebP forms', () => {
    expect(imageDimensions(BASE_PNG, 'image/png')).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(BASE_JPEG, 'image/jpeg')).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(png(4032, 3024), 'image/png')).toEqual({ width: 4032, height: 3024 });
    expect(imageDimensions(jpeg(8000, 6000), 'image/jpeg')).toEqual({ width: 8000, height: 6000 });
    expect(imageDimensions(webpVp8x(9000, 7000), 'image/webp')).toEqual({ width: 9000, height: 7000 });
    expect(imageDimensions(webpVp8l(4000, 3000), 'image/webp')).toEqual({ width: 4000, height: 3000 });
    expect(imageDimensions(webpVp8(1600, 1200), 'image/webp')).toEqual({ width: 1600, height: 1200 });
  });

  it('answers null for what it cannot read, and for non-images', () => {
    expect(imageDimensions(Buffer.from('not an image at all'), 'image/png')).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg')).toBeNull();
    expect(imageDimensions(Buffer.from('%PDF-1.7'), 'application/pdf')).toBeNull();
  });
});

describe('[row 108] the 40-megapixel cap', () => {
  it('is about 40 megapixels', () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
  });

  it('refuses a photo over the cap with a plain 413, in every format', () => {
    for (const [bytes, mime] of [[png(8000, 6000), 'image/png'], [jpeg(8000, 6000), 'image/jpeg'], [webpVp8x(9000, 7000), 'image/webp']] as const) {
      let error: unknown;
      try { assertImageWithinPixelCap(bytes, mime); } catch (caught) { error = caught; }
      expect(error, mime).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode, mime).toBe(413);
      expect((error as AppError).code, mime).toBe('IMAGE_TOO_LARGE');
    }
  });

  it('accepts a phone photo (12 MP), a photo exactly at the cap, unreadable headers and non-images', () => {
    expect(() => assertImageWithinPixelCap(png(4032, 3024), 'image/png')).not.toThrow();
    expect(() => assertImageWithinPixelCap(png(8000, 5000), 'image/png')).not.toThrow();
    expect(() => assertImageWithinPixelCap(Buffer.from('not an image at all'), 'image/png')).not.toThrow();
    expect(() => assertImageWithinPixelCap(Buffer.from('%PDF-1.7'), 'application/pdf')).not.toThrow();
  });
});

describe('[row 108] the storage seam refuses an oversized photo before writing it', () => {
  let dir: string;
  let previous: string | undefined;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'swift-pixel-cap-'));
    previous = process.env['UPLOAD_DIR'];
    process.env['UPLOAD_DIR'] = dir;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env['UPLOAD_DIR'];
    else process.env['UPLOAD_DIR'] = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('an oversized photo is refused and nothing lands on disk; a normal one is stored', async () => {
    const storage = new LocalStorageProvider();
    await expect(storage.upload({ buffer: png(8000, 6000), filename: 'big.png', mimeType: 'image/png', folder: 'vendor-media' }))
      .rejects.toMatchObject({ statusCode: 413, code: 'IMAGE_TOO_LARGE' });
    const listed = async () => (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.png'));
    expect(await listed()).toEqual([]);
    await storage.upload({ buffer: png(1, 1), filename: 'small.png', mimeType: 'image/png', folder: 'vendor-media' });
    expect(await listed()).toHaveLength(1);
  });
});
