import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { cleanStoredPhoto, stripImageMetadataStrict } from '../utils/images';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { REAL_JPEG, REAL_PNG, REAL_WEBP } from './helpers/real-image';
import { PROGRESSIVE_JPEG, PROGRESSIVE_SCAN_OFFSETS, SYNTHETIC_CAMERA_TAG, progressiveWithMetadata } from './helpers/progressive-jpeg';

// ---------------------------------------------------------------------------
// [Row 238 · M044] "Strip the metadata" means ALL of it, wherever the container lets it sit,
// for the one helper every stored photo goes through (the storage seam for plaintext uploads,
// the document envelope for ID photos). Each fixture is a real image with metadata SPLICED in,
// so the only correct answer is the untouched original, byte for byte.
// ---------------------------------------------------------------------------

const TAG = Buffer.from(SYNTHETIC_CAMERA_TAG, 'latin1');

function jpegSegment(code: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, code]), len, payload]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function riff(fourcc: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  return Buffer.concat([Buffer.from(fourcc, 'ascii'), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webp(chunks: Buffer[]): Buffer {
  const payload = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(payload.length + 4, 4);
  head.write('WEBP', 8, 'ascii');
  return Buffer.concat([head, payload]);
}

describe('the strip finds metadata wherever the container lets it sit', () => {
  it.each(PROGRESSIVE_SCAN_OFFSETS.map((o) => [o]))('progressive JPEG: an APP1 between scans (offset %i) goes, every scan stays', (offset) => {
    const clean = stripImageMetadataStrict(progressiveWithMetadata(offset), 'image/jpeg');
    expect(clean?.includes(TAG)).toBe(false);
    expect(clean?.equals(PROGRESSIVE_JPEG)).toBe(true);
  });

  it('progressive JPEG: a comment between scans goes too', () => {
    const clean = stripImageMetadataStrict(progressiveWithMetadata(PROGRESSIVE_SCAN_OFFSETS[5], 0xfe), 'image/jpeg');
    expect(clean?.equals(PROGRESSIVE_JPEG)).toBe(true);
  });

  it('JPEG APP2: an MPF/FlashPix block goes; the ICC colour profile stays', () => {
    const icc = jpegSegment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), Buffer.alloc(16, 7)]));
    const mpf = jpegSegment(0xe2, Buffer.concat([Buffer.from('MPF\0II*\0', 'latin1'), TAG]));
    const withIcc = Buffer.concat([REAL_JPEG.subarray(0, 2), icc, REAL_JPEG.subarray(2)]);
    const dirty = Buffer.concat([REAL_JPEG.subarray(0, 2), icc, mpf, REAL_JPEG.subarray(2)]);
    expect(stripImageMetadataStrict(dirty, 'image/jpeg')?.equals(withIcc)).toBe(true);
  });

  it('JPEG: a photo that ends before its end marker cannot be cleaned (null, so the caller refuses it)', () => {
    const noEnd = REAL_JPEG.subarray(0, REAL_JPEG.indexOf(Buffer.from([0xff, 0xda])));
    expect(stripImageMetadataStrict(noEnd, 'image/jpeg')).toBeNull();
  });

  it('PNG: a private (editor or camera) chunk goes; rendering chunks such as pHYs stay', () => {
    const phys = pngChunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));
    const keep = Buffer.concat([REAL_PNG.subarray(0, 33), phys, REAL_PNG.subarray(33)]);
    const dirty = Buffer.concat([REAL_PNG.subarray(0, 33), phys, pngChunk('prVt', TAG), pngChunk('iDOT', TAG), REAL_PNG.subarray(33)]);
    expect(stripImageMetadataStrict(dirty, 'image/png')?.equals(keep)).toBe(true);
  });

  it('WebP: an unknown chunk goes; the frame stays', () => {
    const frame = REAL_WEBP.subarray(12);
    expect(stripImageMetadataStrict(webp([frame, riff('prVt', TAG)]), 'image/webp')?.equals(REAL_WEBP)).toBe(true);
  });
});

describe('cleanStoredPhoto: the one clean-up every stored photo goes through', () => {
  it('a photo comes back clean, typed by what its bytes are', async () => {
    const dirty = Buffer.concat([REAL_PNG.subarray(0, 33), pngChunk('eXIf', TAG), REAL_PNG.subarray(33)]);
    const photo = await cleanStoredPhoto(dirty, 'image/jpeg');
    expect(photo?.mimeType).toBe('image/png');
    expect(photo?.buffer.equals(REAL_PNG)).toBe(true);
  });

  it('bytes that are not a photo (a PDF, an encrypted envelope) are not its business: null', async () => {
    expect(await cleanStoredPhoto(Buffer.from('%PDF-1.4\n%%EOF\n'), 'application/pdf')).toBeNull();
    expect(await cleanStoredPhoto(Buffer.alloc(64, 9), 'application/octet-stream')).toBeNull();
  });

  it('refuses a declared photo that is not one, and a photo it cannot clean', async () => {
    await expect(cleanStoredPhoto(Buffer.from('not really a photo at all'), 'image/jpeg')).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
    const noEnd = REAL_JPEG.subarray(0, REAL_JPEG.indexOf(Buffer.from([0xff, 0xda])));
    await expect(cleanStoredPhoto(noEnd, 'image/jpeg')).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
  });
});

describe('the storage seam stores the progressive photo without the metadata between its scans', () => {
  let dir: string;
  let previous: string | undefined;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'swift-strip-complete-'));
    previous = process.env['UPLOAD_DIR'];
    process.env['UPLOAD_DIR'] = dir;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env['UPLOAD_DIR'];
    else process.env['UPLOAD_DIR'] = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('every scan boundary', async () => {
    const storage = new LocalStorageProvider();
    for (const offset of PROGRESSIVE_SCAN_OFFSETS) {
      const { url } = await storage.upload({ buffer: progressiveWithMetadata(offset), filename: 'IMG_0421.jpg', mimeType: 'image/jpeg', folder: 'items/synthetic' });
      const onDisk = await readFile(path.join(dir, url.replace(/^\/uploads\//, '')));
      expect(onDisk.equals(PROGRESSIVE_JPEG), `offset ${offset}`).toBe(true);
    }
  });
});
