import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { stripImageMetadata, stripImageMetadataStrict } from '../utils/images';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { PROGRESSIVE_JPEG, PROGRESSIVE_SCAN_OFFSETS, SYNTHETIC_CAMERA_TAG, progressiveWithMetadata } from './fixtures/progressive-jpeg';
import { ICC_PROFILE, ICC_JPEG, ICC_PNG, ICC_NOTE } from './fixtures/icc-images';

export function embeddedProfile(bytes: Buffer): Buffer {
  if (bytes[0] === 0xff) {
    const parts: Buffer[] = [];
    for (let i = 2; i + 4 < bytes.length;) {
      const marker = bytes[i + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const end = i + 2 + bytes.readUInt16BE(i + 2);
      if (marker === 0xe2 && bytes.toString('latin1', i + 4, i + 16) === 'ICC_PROFILE\0') parts.push(bytes.subarray(i + 18, end));
      i = end;
    }
    return Buffer.concat(parts);
  }
  for (let i = 8; i + 12 <= bytes.length;) {
    const end = i + 12 + bytes.readUInt32BE(i);
    if (bytes.toString('ascii', i + 4, i + 8) === 'iCCP') {
      const data = bytes.subarray(i + 8, end - 4);
      return inflateSync(data.subarray(data.indexOf(0) + 2));
    }
    i = end;
  }
  return Buffer.alloc(0);
}

function profileTags(profile: Buffer): Map<string, Buffer> {
  const tags = new Map<string, Buffer>();
  for (let n = 0; n < profile.readUInt32BE(128); n++) {
    const i = 132 + n * 12;
    const start = profile.readUInt32BE(i + 4);
    tags.set(profile.toString('ascii', i, i + 4), profile.subarray(start, start + profile.readUInt32BE(i + 8)));
  }
  return tags;
}

function jpegProfile(profile: Buffer, split = false): Buffer {
  const parts = split ? [profile.subarray(0, 200), profile.subarray(200)] : [profile];
  const segments = parts.map((part, n) => {
    const body = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([n + 1, parts.length]), part]);
    const length = Buffer.alloc(2); length.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, 0xe2]), length, body]);
  });
  return Buffer.concat([PROGRESSIVE_JPEG.subarray(0, 2), ...segments, PROGRESSIVE_JPEG.subarray(2)]);
}

describe('ICC descriptions are metadata, while verified colour transforms survive', () => {
  it.each([['JPEG', ICC_JPEG, 'image/jpeg'], ['PNG', ICC_PNG, 'image/png']] as const)('%s removes descriptive ICC text and preserves every colour tag', (_label, dirty, type) => {
    const original = embeddedProfile(dirty);
    expect(original.includes(Buffer.from(ICC_NOTE, 'utf16le').swap16())).toBe(true);
    const clean = stripImageMetadataStrict(dirty, type);
    expect(clean).not.toBeNull();
    const profile = embeddedProfile(clean!);
    expect(profile.includes(Buffer.from(ICC_NOTE, 'utf16le').swap16())).toBe(false);
    for (const tag of ['wtpt', 'chad', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC', 'chrm']) {
      expect(profileTags(profile).get(tag), tag).toEqual(profileTags(original).get(tag));
    }
    expect(stripImageMetadata(dirty, type)).toEqual(clean);
    expect(stripImageMetadataStrict(clean!, type)).toEqual(clean);
  });

  it('reassembles a split JPEG profile before removing descriptions', () => {
    const clean = stripImageMetadataStrict(jpegProfile(ICC_PROFILE, true), 'image/jpeg');
    expect(clean).not.toBeNull();
    expect(embeddedProfile(clean!).includes(Buffer.from(ICC_NOTE, 'utf16le').swap16())).toBe(false);
    expect(profileTags(embeddedProfile(clean!)).get('rTRC')).toEqual(profileTags(ICC_PROFILE).get('rTRC'));
  });

  it('removes profile identity, reserved bytes, and unreferenced payload', () => {
    const profile = Buffer.concat([ICC_PROFILE, Buffer.from('synthetic-unreferenced-location')]);
    profile.writeUInt32BE(profile.length, 0);
    for (const [start, end] of [[4, 8], [40, 44], [48, 56], [80, 128]] as const) profile.fill(0x41, start, end);
    const clean = stripImageMetadataStrict(jpegProfile(profile), 'image/jpeg');
    expect(clean).not.toBeNull();
    const sanitized = embeddedProfile(clean!);
    for (const [start, end] of [[4, 8], [40, 44], [48, 56], [80, 128]] as const) expect(sanitized.subarray(start, end)).toEqual(Buffer.alloc(end - start));
    expect(sanitized.includes('synthetic-unreferenced-location')).toBe(false);
  });

  it.each(['unknown rendering type', 'tag past the profile', 'duplicate tag', 'unsupported transform', 'unsupported optional transform'])('refuses %s rather than publish an unverified profile', (kind) => {
    const profile = Buffer.from(ICC_PROFILE);
    const rxyz = [...Array(profile.readUInt32BE(128)).keys()].map(n => 132 + n * 12).find(i => profile.toString('ascii', i, i + 4) === 'rXYZ')!;
    if (kind === 'unknown rendering type') profile.write('mluc', profile.readUInt32BE(rxyz + 4));
    if (kind === 'tag past the profile') profile.writeUInt32BE(profile.length, rxyz + 4);
    if (kind === 'duplicate tag') profile.write('desc', rxyz);
    if (kind === 'unsupported transform') profile.write('A2B0', rxyz);
    if (kind === 'unsupported optional transform') {
      const chad = [...Array(profile.readUInt32BE(128)).keys()].map(n => 132 + n * 12).find(i => profile.toString('ascii', i, i + 4) === 'chad')!;
      profile.write('A2B0', chad);
    }
    expect(stripImageMetadataStrict(jpegProfile(profile), 'image/jpeg')).toBeNull();
    expect(stripImageMetadata(jpegProfile(profile), 'image/jpeg')).toEqual(jpegProfile(profile));
  });

  it('refuses missing or duplicate JPEG ICC chunks', () => {
    const partial = jpegProfile(ICC_PROFILE); partial[19] = 2;
    expect(stripImageMetadataStrict(partial, 'image/jpeg')).toBeNull();
    const twice = Buffer.concat([partial.subarray(0, 2), partial.subarray(2, 20 + ICC_PROFILE.length), partial.subarray(2)]);
    expect(stripImageMetadataStrict(twice, 'image/jpeg')).toBeNull();
  });

  it('replaces the PNG profile name and refuses an excessive compressed profile', () => {
    const data = Buffer.concat([Buffer.from('synthetic-location\0\0'), deflateSync(ICC_PROFILE)]);
    const dirty = Buffer.concat([BASE_PNG.subarray(0, 33), pngChunk('iCCP', data), BASE_PNG.subarray(33)]);
    const clean = stripImageMetadataStrict(dirty, 'image/png');
    expect(clean).not.toBeNull();
    expect(clean!.includes('synthetic-location')).toBe(false);
    const huge = Buffer.concat([BASE_PNG.subarray(0, 33), pngChunk('iCCP', Buffer.concat([Buffer.from('ICC\0\0'), deflateSync(Buffer.alloc(2 * 1024 * 1024))])), BASE_PNG.subarray(33)]);
    expect(stripImageMetadataStrict(huge, 'image/png')).toBeNull();
  });

  it('refuses repeated PNG profiles', () => {
    const chunk = pngChunk('iCCP', Buffer.concat([Buffer.from('ICC\0\0'), deflateSync(ICC_PROFILE)]));
    const dirty = Buffer.concat([BASE_PNG.subarray(0, 33), chunk, chunk, BASE_PNG.subarray(33)]);
    expect(stripImageMetadataStrict(dirty, 'image/png')).toBeNull();
  });

  it('sanitizes the same profile in WebP and keeps its colour-profile flag', () => {
    const base = webpWithExif();
    const dirty = Buffer.concat([base, riffChunk('ICCP', ICC_PROFILE)]);
    dirty.writeUInt32LE(dirty.length - 8, 4); dirty[20] = dirty[20]! | 0x20;
    const clean = stripImageMetadataStrict(dirty, 'image/webp');
    expect(clean).not.toBeNull();
    expect(clean!.includes(Buffer.from(ICC_NOTE, 'utf16le').swap16())).toBe(false);
    expect(clean![20]! & 0x20).toBe(0x20);
    expect(stripImageMetadataStrict(clean!, 'image/webp')).toEqual(clean);
    const missing = Buffer.from(base); missing[20] = missing[20]! | 0x20;
    expect(stripImageMetadataStrict(missing, 'image/webp')).toBeNull();
  });
});

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

describe('JPEG metadata after a scan begins', () => {
  it.each(PROGRESSIVE_SCAN_OFFSETS)('removes EXIF before the scan at offset %i without changing any image byte', (offset) => {
    expect(PROGRESSIVE_JPEG.subarray(offset, offset + 2)).toEqual(Buffer.from([0xff, 0xda]));
    const dirty = progressiveWithMetadata(offset);
    expect(dirty.includes(SYNTHETIC_CAMERA_TAG)).toBe(true);
    expect(stripImageMetadataStrict(dirty, 'image/jpeg')?.equals(PROGRESSIVE_JPEG)).toBe(true);
    expect(stripImageMetadata(dirty, 'image/png').equals(PROGRESSIVE_JPEG)).toBe(true);
  });

  it.each([0xed, 0xfe])('removes the non-rendering marker %i between scans', (marker) => {
    const dirty = progressiveWithMetadata(PROGRESSIVE_SCAN_OFFSETS[1], marker);
    expect(stripImageMetadataStrict(dirty, 'image/jpeg')?.equals(PROGRESSIVE_JPEG)).toBe(true);
  });

  it('discards metadata and arbitrary payload after EOI', () => {
    const dirty = Buffer.concat([progressiveWithMetadata(PROGRESSIVE_JPEG.length), Buffer.from('synthetic-trailing-payload')]);
    expect(stripImageMetadataStrict(dirty, 'image/jpeg')?.equals(PROGRESSIVE_JPEG)).toBe(true);
    expect(stripImageMetadata(dirty, 'image/jpeg').equals(PROGRESSIVE_JPEG)).toBe(true);
  });

  it('refuses a metadata segment with a length past the file between scans', () => {
    const offset = PROGRESSIVE_SCAN_OFFSETS[1];
    const dirty = Buffer.concat([PROGRESSIVE_JPEG.subarray(0, offset), Buffer.from([0xff, 0xe1, 0xff, 0xff]), PROGRESSIVE_JPEG.subarray(offset)]);
    expect(stripImageMetadataStrict(dirty, 'image/jpeg')).toBeNull();
    expect(stripImageMetadata(dirty, 'image/jpeg').equals(dirty)).toBe(true);
  });

  it('refuses an unfinished scan and an invalid scan header', () => {
    expect(stripImageMetadataStrict(PROGRESSIVE_JPEG.subarray(0, -2), 'image/jpeg')).toBeNull();
    const dirty = Buffer.from(PROGRESSIVE_JPEG);
    dirty.writeUInt16BE(1, PROGRESSIVE_SCAN_OFFSETS[1] + 2);
    expect(stripImageMetadataStrict(dirty, 'image/jpeg')).toBeNull();
  });

  it('keeps stuffed entropy bytes, restart markers and marker fill bytes', () => {
    const scan = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]);
    const entropy = Buffer.from([0x12, 0xff, 0x00, 0xe1, 0xff, 0xd0, 0x34, 0xff, 0xff, 0xd7, 0x56]);
    const clean = Buffer.concat([scan, entropy, Buffer.from([0xff, 0xff, 0xd9])]);
    expect(stripImageMetadataStrict(clean, 'image/jpeg')?.equals(clean)).toBe(true);
  });
});

describe('a published PNG must have a complete container', () => {
  it.each([8, BASE_PNG.length - 12, BASE_PNG.length - 4])('refuses a PNG truncated at byte %i', (end) => {
    const truncated = BASE_PNG.subarray(0, end);
    expect(stripImageMetadataStrict(truncated, 'image/png')).toBeNull();
    // Private document uploads retain their established fail-open behavior.
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
