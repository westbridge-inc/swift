/**
 * [Row 238 · M044 · GUARDRAILS §2] An ID or document photo loses its location before it is sealed.
 *
 * POST /verification/upload encrypts the file BEFORE the storage seam sees it, so the seam's
 * metadata strip (which cleans every plaintext upload) only ever met ciphertext here: the GPS a
 * phone camera writes sat inside the envelope, and the custody record says device and location
 * are NOT_RECORDED. These tests open the envelope the way the render path does (unwrap the DEK,
 * decrypt) and compare the plaintext with the original image the metadata was spliced into:
 * byte-for-byte equality proves the metadata is gone AND no pixel moved.
 *
 * The digest stays the fingerprint of the file AS SUBMITTED (duplicate-document and retry
 * identity, comparable with every row stored before this change); sizeBytes is what is stored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { decryptBuffer, getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { getStorageProvider } from '../providers/storage/storage-provider';
import { REAL_JPEG, REAL_PNG, REAL_WEBP } from './helpers/real-image';
import { PROGRESSIVE_JPEG, PROGRESSIVE_SCAN_OFFSETS, progressiveWithMetadata } from './helpers/progressive-jpeg';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

let app: FastifyInstance;
const marker = wordFreeTag(6);
const people: string[] = [];

/** What a phone camera writes: coordinates to five decimals, the device and its serial. */
const GPS = 'GPS 6.80448,-58.15527 IMG_0421 SN:F17XR0J2HG7K';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function jpegSegment(code: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, code]), len, payload]);
}

/** The real JPEG with an EXIF (GPS) APP1, an XMP APP1, an MPF APP2 and a comment where cameras put them. */
function jpegFromCamera(note: string): Buffer {
  return Buffer.concat([
    REAL_JPEG.subarray(0, 2),
    jpegSegment(0xe1, Buffer.from(`Exif\0\0${GPS} ${note}`, 'latin1')),
    jpegSegment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS}</x:xmpmeta>`, 'latin1')),
    jpegSegment(0xe2, Buffer.from(`MPF\0II*\0${GPS}`, 'latin1')),
    jpegSegment(0xfe, Buffer.from(GPS, 'latin1')),
    REAL_JPEG.subarray(2),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** The real PNG with eXIf, a text chunk and a private (lower-case, editor-specific) chunk after IHDR. */
function pngFromCamera(note: string): Buffer {
  return Buffer.concat([
    REAL_PNG.subarray(0, 33),
    pngChunk('eXIf', Buffer.from(`MM\0*${GPS} ${note}`, 'latin1')),
    pngChunk('tEXt', Buffer.from(`Location\0${GPS}`, 'latin1')),
    pngChunk('prVt', Buffer.from(GPS, 'latin1')),
    REAL_PNG.subarray(33),
  ]);
}

function riff(fourcc: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  return Buffer.concat([Buffer.from(fourcc, 'ascii'), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** An extended WebP (VP8X advertising EXIF + XMP) around the real 1×1 frame, and what it must clean to. */
function webpFromCamera(note: string): { dirty: Buffer; clean: Buffer } {
  const frame = REAL_WEBP.subarray(12); // the VP8 chunk
  const vp8x = (flags: number) => riff('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const wrap = (chunks: Buffer[]) => {
    const payload = Buffer.concat(chunks);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(payload.length + 4, 4);
    head.write('WEBP', 8, 'ascii');
    return Buffer.concat([head, payload]);
  };
  return {
    dirty: wrap([vp8x(0x08 | 0x04), frame, riff('EXIF', Buffer.from(`II*\0${GPS} ${note}`, 'latin1')), riff('XMP ', Buffer.from(GPS, 'latin1')), riff('prVt', Buffer.from(GPS, 'latin1'))]),
    clean: wrap([vp8x(0), frame]),
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
});

afterAll(async () => {
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: people } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
  await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

async function person() {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Clean', lastName: 'Upload',
    roles: ['MOVER'] as never[], activeRole: 'MOVER' as never, isPhoneVerified: true,
  } });
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'metadata-test', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  people.push(user.id);
  return { id: user.id, token };
}

function upload(token: string, bytes: Buffer, mimeType: string) {
  const boundary = `----swift${marker}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="IMG_0421.jpg"\r\ncontent-type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url: '/api/v1/verification/upload', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
}

/** Upload, then open the envelope exactly as the render path does. */
async function sealed(bytes: Buffer, mimeType: string) {
  const p = await person();
  const res = await upload(p.token, bytes, mimeType);
  expect(res.statusCode, res.body).toBe(200);
  const fileKey = res.json().data.url as string;
  const row = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey } });
  const ciphertext = await getStorageProvider().getObject(fileKey);
  const dek = await getKeyProvider()!.unwrapDek(Buffer.from(row.wrappedDek!));
  const plaintext = decryptBuffer(ciphertext, dek, Buffer.from(row.iv), Buffer.from(row.authTag));
  return { row, plaintext, ciphertext, person: p, fileKey };
}

describe('POST /verification/upload seals the photo without its metadata', () => {
  it('JPEG: EXIF (GPS), XMP, MPF and the comment are gone; the image inside is the original, byte for byte', async () => {
    const dirty = jpegFromCamera(`jpeg-${marker}`);
    const { row, plaintext } = await sealed(dirty, 'image/jpeg');
    expect(plaintext.includes(Buffer.from('GPS 6.80448', 'latin1'))).toBe(false);
    expect(plaintext.equals(REAL_JPEG)).toBe(true);
    expect(row.sizeBytes).toBe(REAL_JPEG.length);
    expect(row.sha256).toBe(sha(dirty));
    expect(row.mimeType).toBe('image/jpeg');
  });

  it('PNG: eXIf, text and private chunks are gone; IHDR/IDAT/IEND survive byte-identical', async () => {
    const dirty = pngFromCamera(`png-${marker}`);
    const { row, plaintext } = await sealed(dirty, 'image/png');
    expect(plaintext.includes(Buffer.from('GPS 6.80448', 'latin1'))).toBe(false);
    expect(plaintext.equals(REAL_PNG)).toBe(true);
    expect(row.sizeBytes).toBe(REAL_PNG.length);
    expect(row.sha256).toBe(sha(dirty));
  });

  it('WebP: EXIF, XMP and unknown chunks are gone and VP8X stops advertising them', async () => {
    const { dirty, clean } = webpFromCamera(`webp-${marker}`);
    const { row, plaintext } = await sealed(dirty, 'image/webp');
    expect(plaintext.includes(Buffer.from('GPS 6.80448', 'latin1'))).toBe(false);
    expect(plaintext.equals(clean)).toBe(true);
    expect(row.sizeBytes).toBe(clean.length);
  });

  it('a progressive JPEG loses metadata hidden between ANY two of its scans', async () => {
    for (const offset of [PROGRESSIVE_SCAN_OFFSETS[0], PROGRESSIVE_SCAN_OFFSETS[4], PROGRESSIVE_SCAN_OFFSETS[9]]) {
      const { plaintext } = await sealed(progressiveWithMetadata(offset), 'image/jpeg');
      expect(plaintext.equals(PROGRESSIVE_JPEG), `scan boundary ${offset}`).toBe(true);
    }
  });

  it('what the bytes ARE decides the clean-up: a PNG sent as image/jpeg loses its location too', async () => {
    const dirty = pngFromCamera(`mislabel-${marker}`);
    const { plaintext } = await sealed(dirty, 'image/jpeg');
    expect(plaintext.equals(REAL_PNG)).toBe(true);
  });

  it('a PDF document is sealed exactly as it came (not a photo; the clean-up never touches it)', async () => {
    const pdf = Buffer.from(`%PDF-1.4\n% synthetic ${marker}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, 'latin1');
    const { row, plaintext } = await sealed(pdf, 'application/pdf');
    expect(plaintext.equals(pdf)).toBe(true);
    expect(row.sizeBytes).toBe(pdf.length);
    expect(row.sha256).toBe(sha(pdf));
  });

  it('FAILS CLOSED: a photo the decoder reads but whose metadata cannot be removed is refused and nothing is stored', async () => {
    // Stray bytes between two segments: libvips reads the header anyway, the segment walk cannot.
    const dirty = jpegFromCamera(`stray-${marker}`);
    const at = dirty.indexOf(Buffer.from([0xff, 0xdb])); // just before the quantisation table
    const unparseable = Buffer.concat([dirty.subarray(0, at), Buffer.from([0x12, 0x34]), dirty.subarray(at)]);
    const p = await person();
    const res = await upload(p.token, unparseable, 'image/jpeg');
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code ?? res.json().code).toBe('IMAGE_UNREADABLE');
    expect(await app.prisma.encryptedObject.count({ where: { createdBy: p.id } })).toBe(0);
  });

  it('a lost-reply retry of the same camera file still answers with the one upload already sealed', async () => {
    const dirty = jpegFromCamera(`retry-${marker}`);
    const p = await person();
    const first = await upload(p.token, dirty, 'image/jpeg');
    const again = await upload(p.token, dirty, 'image/jpeg');
    expect(first.statusCode).toBe(200);
    expect(again.json().data.url).toBe(first.json().data.url);
    expect(await app.prisma.encryptedObject.count({ where: { createdBy: p.id } })).toBe(1);
  });
});
