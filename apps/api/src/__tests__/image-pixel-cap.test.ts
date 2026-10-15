import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, inspectImage } from '../utils/images';
import { LocalStorageProvider } from '../providers/storage/storage-provider';

// ---------------------------------------------------------------------------
// [Row 108] Every stored photo is checked by a real decoder, and refused unless
// it passes. Fail closed.
//
// The check reads the bytes with sharp (libvips), the same decoder that later
// resizes them, never with a separate lightweight header parser a crafted file
// could disagree with. It runs on the bytes that are actually stored (after the
// camera metadata is stripped). A photo is refused when:
//   - the decoder cannot read it (a truncated or corrupt header) → 400 IMAGE_UNREADABLE;
//   - its width or height is missing or zero → 400 IMAGE_UNREADABLE;
//   - what it really is differs from what it claims to be (a polyglot, a renamed
//     file) → 400 IMAGE_TYPE_MISMATCH;
//   - it declares more than about 40 megapixels → 413 IMAGE_TOO_LARGE;
//   - its bytes are far more than its declared size could need (small dimensions
//     over a huge payload) → 400 IMAGE_UNREADABLE.
// ---------------------------------------------------------------------------

let PNG: Buffer;
let JPEG: Buffer;
let WEBP: Buffer;
beforeAll(async () => {
  const source = sharp({ create: { width: 2, height: 2, channels: 3, background: '#bc5935' } });
  PNG = await source.clone().png().toBuffer();
  JPEG = await source.clone().jpeg().toBuffer();
  WEBP = await source.clone().webp().toBuffer();
});

/** A PNG chunk with a correct CRC, so the decoder reads it as genuine. */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
/** The real PNG with its IHDR declaring width × height (CRC recomputed). */
function pngSized(width: number, height: number): Buffer {
  const out = Buffer.from(PNG);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)) >>> 0, 29);
  return out;
}
/** The real JPEG with its frame header declaring width × height. */
function jpegSized(width: number, height: number): Buffer {
  const out = Buffer.from(JPEG);
  const sof = out.indexOf(Buffer.from([0xff, 0xc0]));
  out.writeUInt16BE(height, sof + 5);
  out.writeUInt16BE(width, sof + 7);
  return out;
}
async function refusal(promise: Promise<unknown>): Promise<{ statusCode?: number; code?: string } | null> {
  try { await promise; return null; } catch (error) { return error as { statusCode?: number; code?: string }; }
}

describe('[row 108] the decoder reads every photo, and only real photos pass', () => {
  it('accepts real JPEG, PNG and WebP photos declared as what they are', async () => {
    await expect(inspectImage(JPEG, 'image/jpeg')).resolves.toMatchObject({ format: 'jpeg', width: 2, height: 2 });
    await expect(inspectImage(PNG, 'image/png')).resolves.toMatchObject({ format: 'png', width: 2, height: 2 });
    await expect(inspectImage(WEBP, 'image/webp')).resolves.toMatchObject({ format: 'webp', width: 2, height: 2 });
    await expect(inspectImage(JPEG, 'image/jpg')).resolves.toMatchObject({ format: 'jpeg' });
  });

  it('a truncated header is refused, never passed through', async () => {
    expect(await refusal(inspectImage(PNG.subarray(0, 20), 'image/png'))).toMatchObject({ statusCode: 400, code: 'IMAGE_UNREADABLE' });
    expect(await refusal(inspectImage(JPEG.subarray(0, 12), 'image/jpeg'))).toMatchObject({ statusCode: 400, code: 'IMAGE_UNREADABLE' });
    expect(await refusal(inspectImage(Buffer.from('not an image at all'), 'image/png'))).toMatchObject({ statusCode: 400, code: 'IMAGE_UNREADABLE' });
  });

  it('missing or zero dimensions are refused', async () => {
    expect(await refusal(inspectImage(pngSized(0, 0), 'image/png'))).toMatchObject({ statusCode: 400 });
  });

  it('a PNG/JPEG polyglot or a renamed file is refused: the declared type must be what the decoder finds', async () => {
    const polyglot = Buffer.concat([JPEG, PNG]);
    expect(await refusal(inspectImage(polyglot, 'image/png'))).toMatchObject({ statusCode: 400, code: 'IMAGE_TYPE_MISMATCH' });
    expect(await refusal(inspectImage(PNG, 'image/jpeg'))).toMatchObject({ statusCode: 400, code: 'IMAGE_TYPE_MISMATCH' });
    expect(await refusal(inspectImage(WEBP, 'image/png'))).toMatchObject({ statusCode: 400, code: 'IMAGE_TYPE_MISMATCH' });
    expect(await refusal(inspectImage(PNG, 'image/gif'))).toMatchObject({ statusCode: 400, code: 'IMAGE_TYPE_MISMATCH' });
  });

  it('small declared dimensions over a huge payload are refused', async () => {
    const iend = PNG.length - 12;
    const padded = Buffer.concat([PNG.subarray(0, iend), chunk('zzZz', Buffer.alloc(2 * 1024 * 1024, 7)), PNG.subarray(iend)]);
    expect(await refusal(inspectImage(padded, 'image/png'))).toMatchObject({ statusCode: 400, code: 'IMAGE_UNREADABLE' });
    const trailing = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024, 7)]);
    expect(await refusal(inspectImage(trailing, 'image/jpeg'))).toMatchObject({ statusCode: 400, code: 'IMAGE_UNREADABLE' });
  });
});

describe('[row 108] the 40-megapixel cap', () => {
  it('is about 40 megapixels', () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
  });

  it('refuses a photo over the cap with a plain 413, as the decoder reads it', async () => {
    expect(await refusal(inspectImage(pngSized(8000, 6000), 'image/png'))).toMatchObject({ statusCode: 413, code: 'IMAGE_TOO_LARGE' });
    expect(await refusal(inspectImage(jpegSized(8000, 6000), 'image/jpeg'))).toMatchObject({ statusCode: 413, code: 'IMAGE_TOO_LARGE' });
  });

  it('accepts a phone photo (12 MP) and a photo exactly at the cap', async () => {
    await expect(inspectImage(pngSized(4032, 3024), 'image/png')).resolves.toMatchObject({ width: 4032, height: 3024 });
    await expect(inspectImage(pngSized(8000, 5000), 'image/png')).resolves.toMatchObject({ width: 8000, height: 5000 });
  });

  it('leaves non-images alone (a PDF, an encrypted envelope)', async () => {
    await expect(inspectImage(Buffer.from('%PDF-1.7\n'), 'application/pdf')).resolves.toBeNull();
    await expect(inspectImage(Buffer.alloc(64, 9), 'application/octet-stream')).resolves.toBeNull();
  });
});

describe('[row 108 · S3-1/S3-2] the storage seam: what the bytes ARE decides everything (fixes a privacy gap on main)', () => {
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

  const GPS = 'GPS 6.80448,-58.15527 IMG_0421';
  /** The real PNG with an eXIf chunk (valid CRC) carrying a location, just after IHDR. */
  const pngWithGps = () => Buffer.concat([PNG.subarray(0, 33), chunk('eXIf', Buffer.from(GPS, 'ascii')), PNG.subarray(33)]);
  const files = async () => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const stored = async (url: string) => readFile(path.join(dir, url.replace(/^\/uploads\//, '')));

  it('a PNG carrying a location, declared image/jpeg, is stripped as the PNG it is: no location is stored', async () => {
    const storage = new LocalStorageProvider();
    const { url } = await storage.upload({ buffer: pngWithGps(), filename: 'photo.jpg', mimeType: 'image/jpeg', folder: 'vendor-media' });
    const bytes = await stored(url);
    expect(bytes.includes(GPS)).toBe(false);
    expect(bytes.equals(PNG)).toBe(true);
  });

  it('a 400-megapixel PNG declared image/jpeg is refused by its real size, and nothing is written', async () => {
    const storage = new LocalStorageProvider();
    const before = (await files()).length;
    await expect(storage.upload({ buffer: pngSized(20000, 20000), filename: 'huge.jpg', mimeType: 'image/jpeg', folder: 'vendor-media' })).rejects.toMatchObject({ statusCode: 413, code: 'IMAGE_TOO_LARGE' });
    await expect(storage.upload({ buffer: pngSized(8000, 6000), filename: 'big.png', mimeType: 'image/png', folder: 'vendor-media' })).rejects.toMatchObject({ statusCode: 413, code: 'IMAGE_TOO_LARGE' });
    expect((await files()).length).toBe(before);
  });

  it('a truncated header, or bytes no decoder recognises declared as a photo, is refused; nothing is written', async () => {
    const storage = new LocalStorageProvider();
    const before = (await files()).length;
    for (const [buffer, mimeType] of [[PNG.subarray(0, 20), 'image/png'], [JPEG.subarray(0, 12), 'image/jpeg'], [Buffer.from('not an image at all'), 'image/png']] as const) {
      await expect(storage.upload({ buffer, filename: 'cut.png', mimeType, folder: 'vendor-media' }), mimeType).rejects.toMatchObject({ statusCode: 400, code: 'IMAGE_UNREADABLE' });
    }
    expect((await files()).length).toBe(before);
  });

  it('a JPEG/PNG polyglot is stored as its real type only: the appended part, and its location, are dropped', async () => {
    const storage = new LocalStorageProvider();
    const jpegFirst = await stored((await storage.upload({ buffer: Buffer.concat([JPEG, pngWithGps()]), filename: 'poly.png', mimeType: 'image/png', folder: 'vendor-media' })).url);
    expect(jpegFirst.includes(GPS)).toBe(false);
    expect(jpegFirst.equals(JPEG)).toBe(true);
    const pngFirst = await stored((await storage.upload({ buffer: Buffer.concat([PNG, JPEG]), filename: 'poly.jpg', mimeType: 'image/jpeg', folder: 'vendor-media' })).url);
    expect(pngFirst.equals(PNG)).toBe(true);
  });

  it('non-photos pass untouched: a PDF, an encrypted envelope', async () => {
    const storage = new LocalStorageProvider();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(64, 3)]);
    expect((await stored((await storage.upload({ buffer: pdf, filename: 'a.pdf', mimeType: 'application/pdf', folder: 'docs' })).url)).equals(pdf)).toBe(true);
    const sealed = Buffer.alloc(64, 0x5a);
    expect((await stored((await storage.upload({ buffer: sealed, filename: 'v.enc', mimeType: 'application/octet-stream', folder: 'docs' })).url)).equals(sealed)).toBe(true);
  });
});
