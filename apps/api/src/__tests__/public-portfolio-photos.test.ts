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
  const stats = { reads: 0, failDeletes: false };
  const hooks = { afterUpload: null as null | (() => Promise<void>) };
  return {
    hooks,
    objects,
    stats,
    async upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }) {
      const dot = input.filename.lastIndexOf('.');
      const key = `${input.folder}/${randomBytes(12).toString('base64url')}${dot >= 0 ? input.filename.slice(dot) : '.bin'}`;
      objects.set(key, input.buffer);
      await hooks.afterUpload?.();
      return { url: key };
    },
    async getSignedUrl(key: string) { return `https://bucket.invalid/${key}?X-Amz-Signature=x`; },
    async delete(key: string) { if (stats.failDeletes) throw new Error('storage is down'); objects.delete(key); },
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
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { registerErrorHandler } from '../middleware/error-handler';
import { AccountService } from '../modules/user/account.service';
import { queueStorageOrphan, retryStorageOrphan, retryStorageOrphans } from '../lib/storage-orphans';
import { PUBLIC_PHOTO_REMOVED } from '../utils/public-photo-deletion';
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
    const checklist = await runWithoutTenant(() => providerChecklist(app.prisma, u.userId));
    expect(checklist.length).toBeGreaterThan(0);
    for (const docType of checklist) {
      await runWithoutTenant(() => app.prisma.verificationDocument.create({
        // COMMITTED: the evidence record the verification rule reads is kept from this row (document_record trigger).
        data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', state: 'COMMITTED', reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1' },
      }));
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
  // The seeded market (CI seeds it; a bare database gets the same defaults): a provider's checklist comes from it.
  await runWithoutTenant(() => app.prisma.countryConfig.upsert({ where: { code: 'GY' }, update: {}, create: {
    code: 'GY', name: 'Guyana', currencyCode: 'GYD', currencySymbol: '$', usdExchangeRate: 208.5,
    subscriptionTiers: { mover: 6000, smallVendor: 6000, largeVendor: 12000 },
    documentChecklists: DEFAULT_DOCUMENT_CHECKLISTS,
  } }));
});

beforeEach(() => { resetStorePhotoCachesForTests(); fake.stats.reads = 0; fake.stats.failDeletes = false; fake.hooks.afterUpload = null; });

afterAll(async () => {
  if (userIds.length) {
    await runWithoutTenant(async () => {
      await app.prisma.storageOrphan.deleteMany({ where: { userId: { in: userIds } } });
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

// ---------------------------------------------------------------------------
// [REVIEW-F S2-1 on #1918] A portfolio photo can show a customer's home or people. When it is
// taken down, dropped by a profile save, or its owner's account is erased, its BYTES are deleted,
// not just unlinked: the durable deletion row is written with the pointer change, the object is
// deleted after, and a delete that fails stays owed until the standing retry finishes it.
// [REVIEW-G S3-1] Customers browsing providers are handed only photos Swift keeps in that
// provider's own folder; an outside address saved before photos were upload-only is dropped.
// ---------------------------------------------------------------------------

const orphanOf = (key: string) => runWithoutTenant(() => app.prisma.storageOrphan.findUnique({ where: { key } }));
const portfolioOf = async (providerId: string) =>
  (await runWithoutTenant(() => app.prisma.serviceProvider.findUniqueOrThrow({ where: { id: providerId } }))).portfolioPhotos;
const io = { in: () => ({ disconnectSockets: () => undefined }) };

describe('a portfolio photo that goes is deleted from storage, not just unlinked', () => {
  it('a photo the provider takes down is deleted', async () => {
    const p = await makeProvider(true);
    const key = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    expect(fake.objects.has(key)).toBe(true);
    const down = await send('DELETE', `/api/v1/services/providers/me/portfolio/${key.split('/').pop()}`, p.token);
    expect(down.statusCode).toBe(200);
    expect(fake.objects.has(key)).toBe(false);
    expect((await orphanOf(key))?.purgedAt).toBeInstanceOf(Date);
  });

  it('a photo a profile save drops is deleted; the photos it keeps stay', async () => {
    const p = await makeProvider(true);
    const a = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const b = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const saved = await send('POST', '/api/v1/services/providers', p.token, { trade: 'plumber', bio: 'Pipes and taps', portfolioPhotos: [b] });
    expect(saved.statusCode).toBe(200);
    expect([fake.objects.has(a), fake.objects.has(b)]).toEqual([false, true]);
    expect((await orphanOf(a))?.purgedAt).toBeInstanceOf(Date);
    expect(await orphanOf(b)).toBeNull();
  });

  it('a delete that fails stays owed, and the standing retry finishes it', async () => {
    const p = await makeProvider(true);
    const key = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    fake.stats.failDeletes = true;
    expect((await send('DELETE', `/api/v1/services/providers/me/portfolio/${key.split('/').pop()}`, p.token)).statusCode).toBe(200);
    expect(await portfolioOf(p.providerId)).not.toContain(key);
    expect(fake.objects.has(key)).toBe(true);
    expect((await orphanOf(key))?.purgedAt).toBeNull();
    fake.stats.failDeletes = false;
    await runWithoutTenant(() => retryStorageOrphans(app.prisma, fake, app.log, 500));
    expect(fake.objects.has(key)).toBe(false);
    expect((await orphanOf(key))?.purgedAt).toBeInstanceOf(Date);
  });

  it('a deletion row never deletes a photo a row still shows, one outside the public folders, or one in a folder the row\'s person does not own', async () => {
    const p = await makeProvider(true);
    const other = await makeProvider(true);
    const shown = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const theirs = (await uploadPortfolio(other.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const outside = `verification/${p.userId}/${'k'.repeat(16)}.enc`;
    fake.objects.set(outside, Buffer.from('identity document'));
    // In another provider's folder and listed by no one: only the folder's owner may have it deleted.
    const unlistedTheirs = `portfolio/${other.providerId}/${'u'.repeat(16)}.jpg`;
    fake.objects.set(unlistedTheirs, await cameraJpeg());
    const user = await runWithoutTenant(() => app.prisma.user.findUniqueOrThrow({ where: { id: p.userId }, select: { tenantId: true } }));
    for (const key of [shown, outside, theirs, unlistedTheirs]) {
      const row = await runWithoutTenant(() => queueStorageOrphan(app.prisma, { key, reason: PUBLIC_PHOTO_REMOVED, userId: p.userId, tenantId: user.tenantId }));
      expect(await runWithoutTenant(() => retryStorageOrphan(app.prisma, fake, app.log, row.id))).toBe(false);
      expect(fake.objects.has(key)).toBe(true);
      await runWithoutTenant(() => app.prisma.storageOrphan.delete({ where: { id: row.id } }));
    }
  });

  it('an upload that loses a race (the portfolio filled, or the account closed, while it was kept) is refused and its photo deleted', async () => {
    const p = await makeProvider(true);
    const keys = Array.from({ length: PORTFOLIO_MAX }, (_, i) => `portfolio/${p.providerId}/${String(i).padStart(16, 'y')}.jpg`);
    for (const [race, status, code] of [
      [() => runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: p.providerId }, data: { portfolioPhotos: keys } })), 409, 'PORTFOLIO_FULL'],
      [() => runWithoutTenant(() => app.prisma.user.update({ where: { id: p.userId }, data: { status: 'SUSPENDED' } })), 403, 'ACCOUNT_NOT_ACTIVE'],
    ] as const) {
      await runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: p.providerId }, data: { portfolioPhotos: [] } }));
      const before = new Set(fake.objects.keys());
      fake.hooks.afterUpload = async () => { await race(); };
      const res = await uploadPortfolio(p.token, await cameraJpeg());
      fake.hooks.afterUpload = null;
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
      expect((await portfolioOf(p.providerId)).filter((k) => !keys.includes(k))).toEqual([]);
      expect([...fake.objects.keys()].filter((k) => !before.has(k))).toEqual([]);
    }
  });

  it('an upload whose save fails (a database error after the photo was kept) gets a deletion row and its photo is deleted [S4-1]', async () => {
    const p = await makeProvider(true);
    const before = new Set(fake.objects.keys());
    let kept = '';
    const save = vi.spyOn(app.prisma, '$transaction');
    fake.hooks.afterUpload = async () => {
      kept = [...fake.objects.keys()].find((k) => !before.has(k)) ?? '';
      save.mockImplementationOnce((() => Promise.reject(new Error('database went away'))) as never);
    };
    const res = await uploadPortfolio(p.token, await cameraJpeg());
    fake.hooks.afterUpload = null;
    save.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(kept).toMatch(new RegExp(`^portfolio/${p.providerId}/`));
    expect(await portfolioOf(p.providerId)).toEqual([]);
    expect(fake.objects.has(kept)).toBe(false);
    expect((await orphanOf(kept))?.purgedAt).toBeInstanceOf(Date);
  });

  it('account erasure deletes every portfolio photo and clears the list; a failed delete keeps the receipt pending until the retry', async () => {
    const p = await makeProvider(false);
    const a = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const b = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    // (The fixture's placeholder selfie address is not one Swift issued; it would keep its own obligation open.)
    await runWithoutTenant(() => app.prisma.user.update({ where: { id: p.userId }, data: { avatar: null } }));
    const account = () => new AccountService({ prisma: app.prisma, log: app.log, io: io as never });
    fake.stats.failDeletes = true;
    const first = await account().deleteAccount(p.userId);
    expect(first).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
    expect((first as { pendingUploads: number }).pendingUploads).toBeGreaterThanOrEqual(2);
    expect(await portfolioOf(p.providerId)).toEqual([]);
    expect([fake.objects.has(a), fake.objects.has(b)]).toEqual([true, true]);
    fake.stats.failDeletes = false;
    // Older owed deletions elsewhere fill the sweep's own small batch: this person's photos are retried by name.
    const other = await makeProvider(false);
    const otherUser = await runWithoutTenant(() => app.prisma.user.findUniqueOrThrow({ where: { id: other.userId }, select: { tenantId: true } }));
    await runWithoutTenant(() => app.prisma.storageOrphan.createMany({ data: Array.from({ length: 6 }, (_, i) => ({
      key: `portfolio/${other.providerId}/${String(i).padStart(16, 'z')}.jpg`, reason: PUBLIC_PHOTO_REMOVED,
      userId: other.userId, tenantId: otherUser.tenantId, createdAt: new Date(Date.UTC(2000, 0, 1, 0, i)),
    })) }));
    const again = await account().deleteAccount(p.userId);
    expect([fake.objects.has(a), fake.objects.has(b)]).toEqual([false, false]);
    expect((await orphanOf(a))?.purgedAt).toBeInstanceOf(Date);
    expect((await orphanOf(b))?.purgedAt).toBeInstanceOf(Date);
    expect((again as { pendingUploads?: number }).pendingUploads ?? 0).toBe(0);
  });
});

describe('customers browsing providers are handed only photos Swift keeps [REVIEW-G S3-1]', () => {
  it('an outside address or another provider\'s key in a portfolio is dropped from the browse list', async () => {
    const p = await makeProvider(true);
    const other = await makeProvider(true);
    const key = (await uploadPortfolio(p.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    const theirs = (await uploadPortfolio(other.token, await cameraJpeg())).json().data.portfolioPhotos.at(-1) as string;
    await runWithoutTenant(() => app.prisma.serviceProvider.update({
      where: { id: p.providerId },
      data: { portfolioPhotos: ['https://elsewhere.example/work.jpg', key, theirs, '//elsewhere.example/w.jpg'] },
    }));
    const found = async (): Promise<{ id: string; portfolioPhotos: string[] } | undefined> => {
      let cursor: string | undefined;
      for (let page = 0; page < 40; page += 1) {
        const res = await send('GET', `/api/v1/services/providers?trade=plumber&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(res.statusCode).toBe(200);
        const data = res.json().data as { providers: Array<{ id: string; portfolioPhotos: string[] }>; page: { nextCursor: string | null } };
        const hit = data.providers.find((x) => x.id === p.providerId);
        if (hit || !data.page.nextCursor) return hit;
        cursor = data.page.nextCursor;
      }
      return undefined;
    };
    const listed = await found();
    expect(listed?.portfolioPhotos).toEqual([key]);
  });
});
