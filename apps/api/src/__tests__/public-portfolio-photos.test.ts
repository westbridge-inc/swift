import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';

// ---------------------------------------------------------------------------
// [IMAGES-E2E PR3] A service provider's portfolio: photos of their own work,
// uploaded (scanned, redrawn without camera data, kept under portfolio/<provider>/)
// and served by the public photo door only while a provider customers may see
// still lists them. Before this, a profile save took any outside address as a
// "portfolio photo", and nothing could show one.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const objects = new Map<string, Buffer>();
  const stats = { reads: 0 };
  return {
    objects,
    stats,
    async upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }) {
      const dot = input.filename.lastIndexOf('.');
      const key = `${input.folder}/${randomBytes(12).toString('base64url')}${dot >= 0 ? input.filename.slice(dot) : '.bin'}`;
      objects.set(key, input.buffer);
      return { url: key };
    },
    async getSignedUrl(key: string) { return `https://bucket.invalid/${key}?X-Amz-Signature=x`; },
    async delete(key: string) { objects.delete(key); },
    async getObject(key: string) {
      const b = objects.get(key);
      if (!b) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return b;
    },
    async getObjectWithin(key: string, maxBytes: number) {
      stats.reads += 1;
      const b = objects.get(key);
      return b && b.length <= maxBytes ? b : null;
    },
  };
});

vi.mock('../providers/storage/storage-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/storage/storage-provider')>()),
  getStorageProvider: () => fake,
}));

import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes, PORTFOLIO_MAX } from '../modules/services/services.routes';
import { providerChecklist } from '../modules/services/services.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicStorePhotos, resetStorePhotoCachesForTests } from '../utils/public-store-photos';
import { testPhone } from './helpers/fixture-ids';

const DAY = 24 * 60 * 60 * 1000;
const PLACE = '6,48.5208N';
let app: FastifyInstance;
const userIds: string[] = [];

async function makeUser(): Promise<{ userId: string; token: string }> {
  const roles: UserRole[] = ['CUSTOMER'];
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: testPhone(), firstName: 'Folio', lastName: 'Maker', roles, activeRole: 'CUSTOMER', tenantId: 'swift-default',
        isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: 'storage://test/provider-selfie.jpg', customer: { create: {} },
      },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'folio-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

const send = (method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, payload?: Record<string, unknown>) => app.inject({
  method, url,
  ...(payload ? { payload } : {}),
  headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

/** A provider with a profile; `verified` approves every document its trade's checklist asks for. */
async function makeProvider(verified: boolean) {
  const u = await makeUser();
  await send('POST', '/api/v1/services/providers', u.token, { trade: 'plumber', bio: 'Pipes and taps' });
  if (verified) {
    for (const docType of await providerChecklist(app.prisma, u.userId)) {
      await app.prisma.verificationDocument.create({
        data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
      });
    }
  }
  const res = await send('POST', '/api/v1/services/providers', u.token, { trade: 'plumber', bio: 'Pipes and taps' });
  return { ...u, providerId: res.json().data.id as string };
}

async function cameraJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .withExif({
      IFD0: { Make: 'SecretMaker', Model: 'SecretPhoneModel' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 48/1 3125/100', GPSLongitudeRef: 'W', GPSLongitude: '58/1 9/1 3600/100' },
    })
    .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="${PLACE}"/></rdf:RDF></x:xmpmeta>`)
    .withIccProfile('p3')
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function uploadPortfolio(token: string, bytes: Buffer, filename = 'work.jpg', type = 'image/jpeg') {
  const boundary = `----swift${nanoid(8)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${type}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST', url: '/api/v1/services/providers/me/portfolio', payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  registerPublicStorePhotos(app, fake);
  await app.ready();
});

beforeEach(() => { resetStorePhotoCachesForTests(); fake.stats.reads = 0; });

afterAll(async () => {
  if (userIds.length) {
    await runWithoutTenant(async () => {
      await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
  }
  await app.close();
});

describe('a provider uploads photos of their work; customers see them', () => {
  it('the photo is kept redrawn (no EXIF/GPS/XMP/ICC, at most 1600 px) and the door serves it', async () => {
    const p = await makeProvider(true);
    const res = await uploadPortfolio(p.token, await cameraJpeg());
    expect(res.statusCode).toBe(200);
    const key = (res.json().data.portfolioPhotos as string[]).at(-1)!;
    expect(key).toMatch(new RegExp(`^portfolio/${p.providerId}/[A-Za-z0-9_-]{16}\\.jpg$`));
    const stored = fake.objects.get(key)!;
    const meta = await sharp(stored).metadata();
    expect([meta.exif, meta.xmp, meta.icc, meta.iptc]).toEqual([undefined, undefined, undefined, undefined]);
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    for (const secret of ['SecretMaker', 'SecretPhoneModel', PLACE, 'Exif\0\0']) expect(stored.includes(Buffer.from(secret))).toBe(false);
    const served = await send('GET', `/${key}?w=320`);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(served.rawPayload).metadata()).width).toBe(320);
  });

  it('a provider not yet verified publishes nothing; nor one whose account is closed', async () => {
    const unverified = await makeProvider(false);
    const key = (await uploadPortfolio(unverified.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    expect((await send('GET', `/${key}`)).statusCode).toBe(404);

    const closed = await makeProvider(true);
    const closedKey = (await uploadPortfolio(closed.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    expect((await send('GET', `/${closedKey}`)).statusCode).toBe(200);
    await runWithoutTenant(() => app.prisma.user.update({ where: { id: closed.userId }, data: { status: 'SUSPENDED' } }));
    resetStorePhotoCachesForTests();
    const refused = await send('GET', `/${closedKey}`);
    expect(refused.statusCode).toBe(404);
    expect(refused.headers['cache-control']).toBe('no-store');
  });

  it('a photo the provider takes down is no longer served; a name the portfolio never listed never was', async () => {
    const p = await makeProvider(true);
    const key = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    expect((await send('GET', `/${key}`)).statusCode).toBe(200);
    const down = await send('DELETE', `/api/v1/services/providers/me/portfolio/${key.split('/').pop()}`, p.token);
    expect(down.statusCode).toBe(200);
    expect(down.json().data.portfolioPhotos).not.toContain(key);
    resetStorePhotoCachesForTests();
    expect((await send('GET', `/${key}`)).statusCode).toBe(404);
    fake.objects.set(`portfolio/${p.providerId}/AbCdEfGhIjKlMnOp.jpg`, await cameraJpeg());
    expect((await send('GET', `/portfolio/${p.providerId}/AbCdEfGhIjKlMnOp.jpg`)).statusCode).toBe(404);
    expect(fake.stats.reads).toBe(1);
  });

  it('a profile save may keep, reorder or drop portfolio photos, never add an address', async () => {
    const p = await makeProvider(true);
    const a = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const b = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const save = (portfolioPhotos: string[]) => send('POST', '/api/v1/services/providers', p.token, { trade: 'plumber', bio: 'Pipes and taps', portfolioPhotos });
    for (const bad of [[a, 'https://elsewhere.example/x.jpg'], [a, `portfolio/${p.providerId}/../../verification/x.jpg`], [a, a]]) {
      const res = await save(bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('PORTFOLIO_UPLOAD_ONLY');
    }
    const reordered = await save([b, a]);
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().data.portfolioPhotos).toEqual([b, a]);
    expect((await save([b])).json().data.portfolioPhotos).toEqual([b]);
  });

  it(`a portfolio holds ${PORTFOLIO_MAX} photos; a file that is not a photo is refused`, async () => {
    const p = await makeProvider(true);
    const keys = Array.from({ length: PORTFOLIO_MAX }, (_, i) => `portfolio/${p.providerId}/${String(i).padStart(16, 'x')}.jpg`);
    await runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: p.providerId }, data: { portfolioPhotos: keys } }));
    const full = await uploadPortfolio(p.token, await cameraJpeg());
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('PORTFOLIO_FULL');
    await runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: p.providerId }, data: { portfolioPhotos: [] } }));
    const notPhoto = await uploadPortfolio(p.token, Buffer.from('#!/bin/sh\necho hi\n'.repeat(4)), 'work.png', 'image/png');
    expect(notPhoto.statusCode).toBe(400);
    expect(notPhoto.json().error.code).toBe('BAD_IMAGE');
  });

  it('someone with no provider profile cannot upload', async () => {
    const u = await makeUser();
    const res = await uploadPortfolio(u.token, await cameraJpeg());
    expect(res.statusCode).toBe(404);
  });
});
