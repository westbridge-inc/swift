import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildApp } from '../app';
import { tenantUnscopedAccessCounter } from '../plugins/observability';
import { runWithoutTenant } from '../plugins/tenant-context';
import { windDownPartner } from '../modules/user/partner-wind-down';

// ---------------------------------------------------------------------------
// [PUBLIC-PHOTOS] Stores' own photos are served by the API, whatever the
// storage provider.
//
// On a managed runtime (staging, production) photos live in a PRIVATE object
// store and the upload route saves the bare object key ("items/<store>/<file>").
// Every client puts the API origin in front of a stored value that is not a
// full address — build 9 (the store app under review) does it in
// apps/mobile/src/lib/images.ts at f904aba1:
//
//   export function mediaUrl(url?: string | null): string | null {
//     if (!url) return null;
//     if (/^https?:\/\//.test(url)) return url;
//     return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
//   }
//
// so build 9 asks for "<api>/items/<store>/<file>". Nothing on the API
// answered that path, and every uploaded menu photo drew as broken.
//
// The route serves ONLY the stores' public photo folder, ONLY while a store a
// guest may see (the public catalogue's own wall) still uses the exact photo
// (a menu item, a menu section, the store's logo or cover), only real images
// within the upload size limit, within a storage deadline, and with a cache
// short enough that a removal takes effect within the hour. Identity documents
// and every other private upload stay unreachable. The local-disk address
// (/uploads/items/...) follows the same rules.
// ---------------------------------------------------------------------------

const BUCKET = `public-photos-test-${nanoid(6)}`;
const PHONE_PREFIX = '+5920874';
/** Two digits per run, so a leftover row from an interrupted run never collides. */
const RUN = String(Date.now() % 100).padStart(2, '0');
const MAX = 5 * 1024 * 1024;

const ENV_KEYS = ['STORAGE_PROVIDER', 'AWS_S3_BUCKET', 'AWS_S3_ENDPOINT', 'UPLOAD_DIR', 'TENANT_UNSCOPED_ACCESS', 'PUBLIC_PHOTO_READ_TIMEOUT_MS', 'RUN_WORKERS'] as const;
/** The storage deadline this suite runs with (production default: a few seconds). */
const DEADLINE_MS = 300;
const HOUR = 'public, max-age=3600';
const priorEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// --- a private bucket, in memory -------------------------------------------
interface StoredObject { body: Buffer; contentType: string; contentLength?: number }
const bucket = new Map<string, StoredObject>();
const asked: string[] = [];
const bodiesRead: string[] = [];
/** Keys whose storage answer never arrives, or whose body never finishes. */
const stalledSend = new Set<string>();
const stalledBody = new Set<string>();
const aborted: string[] = [];
const destroyed: string[] = [];

function missing(): Error {
  const err = new Error('The specified key does not exist.');
  err.name = 'NoSuchKey';
  (err as Error & { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
  return err;
}

const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
  if (command instanceof PutObjectCommand) {
    const { Bucket, Key, Body, ContentType } = command.input;
    if (Bucket !== BUCKET) throw new Error(`wrong bucket ${Bucket}`);
    bucket.set(Key!, { body: Buffer.from(Body as Buffer), contentType: ContentType ?? 'application/octet-stream' });
    return {};
  }
  if (command instanceof GetObjectCommand) {
    const { Bucket, Key } = command.input;
    if (Bucket !== BUCKET) throw new Error(`wrong bucket ${Bucket}`);
    asked.push(Key!);
    options?.abortSignal?.addEventListener('abort', () => aborted.push(Key!));
    // A storage connection that never answers.
    if (stalledSend.has(Key!)) return new Promise(() => undefined);
    const obj = bucket.get(Key!);
    if (!obj) throw missing();
    return {
      ContentType: obj.contentType,
      ContentLength: obj.contentLength ?? obj.body.length,
      Body: {
        // A body that starts and then stalls.
        transformToByteArray: stalledBody.has(Key!)
          ? () => new Promise<Uint8Array>(() => undefined)
          : async () => { bodiesRead.push(Key!); return new Uint8Array(obj.body); },
        destroy: () => { destroyed.push(Key!); },
      },
    };
  }
  throw new Error('unexpected storage command');
}) as never);

// --- real image bytes (magic numbers + padding) ------------------------------
const jpeg = (fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(96, fill), Buffer.from([0xff, 0xd9])]);
const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, fill)]);
const webp = (fill: number) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x60, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(96, fill)]);

let app: FastifyInstance;
/** The local-provider app (its own describe below); closed last, after the
 *  cleanup reads, because both apps share one database client. */
let local: FastifyInstance | undefined;
const userIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;

async function makeStoreOwner(opts: { tenantId?: string; status?: 'ACTIVE' | 'PENDING_APPROVAL'; isVerified?: boolean } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${RUN}${String(seq).padStart(2, '0')}`,
      firstName: 'Photo', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(opts.tenantId && { tenantId: opts.tenantId }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'public-photos', deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
  });
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Photo Store ${seq}`, slug: `photo-store-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}${RUN}${String(seq).padStart(2, '0')}`, addressLine1: '1 Photo Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: opts.status ?? 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: opts.isVerified ?? true,
      ...(opts.tenantId && { tenantId: opts.tenantId }),
    },
  });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains' } });
  return { userId: user.id, token, vendorId: vendor.id, categoryId: category.id };
}

async function addItem(vendorId: string, categoryId: string, imageUrl: string | null) {
  return app.prisma.item.create({ data: { vendorId, categoryId, name: `Dish ${nanoid(4)}`, basePrice: 1000, imageUrl, dietaryTags: [], allergens: [] } });
}

/** An opaque name in the shape the upload route mints (nanoid(16) + extension). */
const opaque = (ext: string) => `${nanoid(16)}${ext}`;

let storeA: Awaited<ReturnType<typeof makeStoreOwner>>;
let storeB: Awaited<ReturnType<typeof makeStoreOwner>>;
const keys = {} as Record<'item' | 'cover' | 'logo' | 'section' | 'orphan' | 'notImage' | 'tooBig' | 'privateDoc' | 'otherStoresPick' | 'mislabelled', string>;
let itemId = '';

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['STORAGE_PROVIDER'] = 's3';
  process.env['AWS_S3_BUCKET'] = BUCKET;
  process.env['PUBLIC_PHOTO_READ_TIMEOUT_MS'] = String(DEADLINE_MS);
  // The API tier only: no queue consumers and no recurring schedules, which
  // would outlive this file in the shared test Redis (the golden worker
  // suites require an empty schedule).
  process.env['RUN_WORKERS'] = '0';
  delete process.env['AWS_S3_ENDPOINT'];
  app = await buildApp();
  await app.ready();

  storeA = await makeStoreOwner();
  storeB = await makeStoreOwner();
  const A = storeA.vendorId;
  keys.item = `items/${A}/${opaque('.jpg')}`;
  keys.cover = `items/${A}/${opaque('.png')}`;
  keys.logo = `items/${A}/${opaque('.webp')}`;
  keys.section = `items/${A}/${opaque('.jpg')}`;
  keys.orphan = `items/${A}/${opaque('.jpg')}`;
  keys.notImage = `items/${A}/${opaque('.jpg')}`;
  keys.tooBig = `items/${A}/${opaque('.jpg')}`;
  keys.mislabelled = `items/${A}/${opaque('.jpg')}`;
  keys.otherStoresPick = `items/${A}/${opaque('.jpg')}`;
  keys.privateDoc = `verification/${storeA.userId}/${opaque('.jpg')}`;

  bucket.set(keys.item, { body: jpeg(1), contentType: 'image/jpeg' });
  bucket.set(keys.cover, { body: png(2), contentType: 'image/png' });
  bucket.set(keys.logo, { body: webp(3), contentType: 'image/webp' });
  bucket.set(keys.section, { body: jpeg(4), contentType: 'image/jpeg' });
  bucket.set(keys.orphan, { body: jpeg(5), contentType: 'image/jpeg' });
  bucket.set(keys.notImage, { body: Buffer.from('<html><script>alert(1)</script></html>'.padEnd(120, ' ')), contentType: 'image/jpeg' });
  bucket.set(keys.tooBig, { body: jpeg(6), contentType: 'image/jpeg', contentLength: MAX + 1 });
  bucket.set(keys.mislabelled, { body: png(7), contentType: 'image/jpeg' });
  bucket.set(keys.otherStoresPick, { body: jpeg(8), contentType: 'image/jpeg' });
  bucket.set(keys.privateDoc, { body: jpeg(9), contentType: 'image/jpeg' });

  itemId = (await addItem(A, storeA.categoryId, keys.item)).id;
  await addItem(A, storeA.categoryId, keys.notImage);
  await addItem(A, storeA.categoryId, keys.tooBig);
  await addItem(A, storeA.categoryId, keys.mislabelled);
  // A store that pasted a private key as an item photo still cannot publish it.
  await addItem(A, storeA.categoryId, keys.privateDoc);
  await app.prisma.category.update({ where: { id: storeA.categoryId }, data: { imageUrl: keys.section } });
  await app.prisma.vendor.update({ where: { id: A }, data: { coverImageUrl: keys.cover, logoUrl: keys.logo } });
  // Store B points at a photo in store A's folder that store A no longer uses.
  await addItem(storeB.vendorId, storeB.categoryId, keys.otherStoresPick);
  await app.prisma.vendor.update({ where: { id: storeB.vendorId }, data: { coverImageUrl: keys.otherStoresPick } });
});

afterAll(async () => {
  if (userIds.length) {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await runWithoutTenant(() => app.prisma.user.deleteMany({ where: { id: { in: userIds } } }), 'test-cleanup:public-store-photos');
  }
  if (tenantIds.length) {
    await runWithoutTenant(() => app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }), 'test-cleanup:public-store-photos');
  }
  send.mockRestore();
  for (const k of ENV_KEYS) {
    if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
  }
  await local?.close();
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url });

/** POST a photo to the real menu-photo upload route of `on`. */
async function uploadPhoto(on: FastifyInstance, store: { token: string }, itemId: string, filename: string, mime: string, bytes: Buffer) {
  const boundary = `----swift${nanoid(8)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await on.inject({
    method: 'POST', url: `/api/v1/vendor/items/${itemId}/image`, payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${store.token}` },
  });
  expect(up.statusCode, up.body).toBe(200);
  return up.json().data.imageUrl as string;
}

/** Database reads the route has made (its system capability is counted by the tenant wall). */
async function photoLookups(): Promise<number> {
  const metric = await tenantUnscopedAccessCounter.get();
  return metric.values.filter((v) => v.labels['capability'] === 'public-store-photo').reduce((n, v) => n + v.value, 0);
}

describe('[PUBLIC-PHOTOS] a store photo in private object storage is served at the address the apps build', () => {
  it('a menu item photo: the exact bytes, as an image, cached for an hour, embeddable by the website', async () => {
    const res = await get(`/${keys.item}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.rawPayload.equals(bucket.get(keys.item)!.body)).toBe(true);
    // An hour, never `immutable`: a removed photo stops being served within the hour.
    expect(res.headers['cache-control']).toBe(HOUR);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The key is read literally from the configured bucket.
    expect(asked).toContain(keys.item);
  });

  it('the store cover, the store logo and a menu section photo are served too', async () => {
    const cover = await get(`/${keys.cover}`);
    expect(cover.statusCode, cover.body).toBe(200);
    expect(cover.headers['content-type']).toBe('image/png');
    const logo = await get(`/${keys.logo}`);
    expect(logo.statusCode, logo.body).toBe(200);
    expect(logo.headers['content-type']).toBe('image/webp');
    const section = await get(`/${keys.section}`);
    expect(section.statusCode, section.body).toBe(200);
    expect(section.headers['content-type']).toBe('image/jpeg');
  });

  it('build 9: the value the upload route returns, with the API origin in front, shows the uploaded photo', async () => {
    const boundary = `----swift${nanoid(8)}`;
    const bytes = jpeg(10);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="dish.jpg"\r\ncontent-type: image/jpeg\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST', url: `/api/v1/vendor/items/${itemId}/image`, payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${storeA.token}` },
    });
    expect(up.statusCode, up.body).toBe(200);
    const stored: string = up.json().data.imageUrl;
    expect(stored).toMatch(new RegExp(`^items/${storeA.vendorId}/[A-Za-z0-9_-]{16}\\.jpg$`));
    // build 9's mediaUrl(): `${API_URL}/${stored}` → this path on the API.
    const res = await get(`/${stored}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.rawPayload.equals(bucket.get(stored)!.body)).toBe(true);
    // The photo it replaced is no longer the store's, so it is no longer served.
    const replaced = await get(`/${keys.item}`);
    expect(replaced.statusCode).toBe(404);
  });

  it('the content type comes from the bytes, never from the stored label', async () => {
    const res = await get(`/${keys.mislabelled}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('answers while the database wall refuses unbound reads (TENANT_UNSCOPED_ACCESS=deny)', async () => {
    process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
    try {
      const res = await get(`/${keys.cover}`);
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      if (priorEnv['TENANT_UNSCOPED_ACCESS'] === undefined) delete process.env['TENANT_UNSCOPED_ACCESS'];
      else process.env['TENANT_UNSCOPED_ACCESS'] = priorEnv['TENANT_UNSCOPED_ACCESS'];
    }
  });
});

describe('[PUBLIC-PHOTOS] what is never served', () => {
  it('an identity document is never served — not at its own address, not under /uploads, not even when a store pasted its key as a photo', async () => {
    const before = asked.length;
    for (const url of [`/${keys.privateDoc}`, `/uploads/${keys.privateDoc}`]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
    }
    expect(asked.slice(before).filter((k) => !k.startsWith('items/'))).toEqual([]);
  });

  it('a path that climbs out of the photo folder is refused before the database or storage is asked', async () => {
    const A = storeA.vendorId;
    const docName = keys.privateDoc.split('/').pop()!;
    const before = asked.length;
    // The check that a store still uses a photo reads the database; prove it runs at all, then that none of these reach it.
    await get(`/${keys.item}`);
    const lookups = await photoLookups();
    expect(lookups).toBeGreaterThan(0);
    for (const url of [
      `/items/..%2F..%2Fverification%2F${storeA.userId}/${docName}`,
      `/items/${A}%2F..%2F..%2Fverification%2F${storeA.userId}/${docName}`,
      `/items/${A}/..%2F..%2Fverification%2F${storeA.userId}%2F${docName}`,
      `/items/..%2Fverification/${storeA.userId}%2F${docName}`,
      `/items/%2e%2e/%2e%2e%2Fverification%2F${storeA.userId}%2F${docName}`,
      `/items/${A}/%2e%2e`,
      `/items/${A}/x%00.jpg`,
      `/items/${A}/a%5C..%5C..%5Cverification.jpg`,
      `/items/../verification/${storeA.userId}/${docName}`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).not.toBe(200);
      expect([400, 404], url).toContain(res.statusCode);
    }
    expect(asked.slice(before).filter((k) => k !== keys.item)).toEqual([]);
    expect(await photoLookups(), 'database asked for a malformed address').toBe(lookups);
  });

  it('a photo the store no longer uses is not served, and storage is never asked for it', async () => {
    const before = asked.length;
    const res = await get(`/${keys.orphan}`);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(asked.slice(before)).toEqual([]);
  });

  it('another store cannot publish a photo from this store’s folder by pointing at it', async () => {
    const res = await get(`/${keys.otherStoresPick}`);
    expect(res.statusCode).toBe(404);
  });

  it('a stored object that is not a real image is never served', async () => {
    const res = await get(`/${keys.notImage}`);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type'] ?? '').not.toMatch(/html/);
    expect(res.body).not.toContain('<script>');
  });

  it('an object over the upload size limit is refused without downloading it', async () => {
    const res = await get(`/${keys.tooBig}`);
    expect(res.statusCode).toBe(404);
    expect(bodiesRead).not.toContain(keys.tooBig);
  });

  it('other private folders are not routed at all', async () => {
    const before = asked.length;
    for (const folder of ['verification', 'liveness', 'courier-proof', 'handover-proof', 'chat', 'ads', 'avatars', 'vehicles']) {
      const res = await get(`/${folder}/${storeA.vendorId}/${opaque('.jpg')}`);
      expect(res.statusCode, folder).toBe(404);
    }
    expect(asked.slice(before)).toEqual([]);
  });
});

describe('[PUBLIC-PHOTOS] only a store a guest may see — the public catalogue\'s own wall', () => {
  async function tenant(kind: 'REVIEW' | 'PRODUCTION', isActive: boolean) {
    const id = `photos-${kind.toLowerCase()}-${nanoid(6).toLowerCase()}`;
    await runWithoutTenant(() => app.prisma.tenant.create({ data: { id, name: `Photos ${kind}`, slug: id, kind, isActive } }), 'test-fixture:public-store-photos');
    tenantIds.push(id);
    return id;
  }
  async function storeWithPhoto(opts: Parameters<typeof makeStoreOwner>[0] = {}) {
    const store = await makeStoreOwner(opts);
    const key = `items/${store.vendorId}/${opaque('.jpg')}`;
    bucket.set(key, { body: jpeg(20), contentType: 'image/jpeg' });
    await addItem(store.vendorId, store.categoryId, key);
    return { ...store, key };
  }
  const refused = async (key: string) => {
    const before = asked.length;
    const res = await get(`/${key}`);
    expect(res.statusCode, key).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(asked.slice(before), 'storage asked for a photo that is not served').toEqual([]);
  };

  it('a store in a REVIEW tenant: its photo is not served to a guest', async () => {
    await refused((await storeWithPhoto({ tenantId: await tenant('REVIEW', true) })).key);
  });

  it('an operator switched off: its stores\' photos are not served', async () => {
    await refused((await storeWithPhoto({ tenantId: await tenant('PRODUCTION', false) })).key);
  });

  it('a store not yet approved, or whose papers are not verified, is not shown', async () => {
    await refused((await storeWithPhoto({ status: 'PENDING_APPROVAL' })).key);
    await refused((await storeWithPhoto({ isVerified: false })).key);
  });

  it('a partner who closes their account (the real wind-down): the store\'s photos stop being served', async () => {
    const store = await storeWithPhoto();
    expect((await get(`/${store.key}`)).statusCode).toBe(200);
    await windDownPartner(app.prisma, store.userId);
    await refused(store.key);
  });
});

describe('[PUBLIC-PHOTOS] a stalled storage read ends fast', () => {
  it('a storage answer that never comes: 504 within the deadline, and the request is aborted', async () => {
    const key = `items/${storeA.vendorId}/${opaque('.jpg')}`;
    stalledSend.add(key);
    await addItem(storeA.vendorId, storeA.categoryId, key);
    const started = Date.now();
    const res = await get(`/${key}`);
    expect(res.statusCode).toBe(504);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS + 1500);
    expect(aborted).toContain(key);
  });

  it('a body that starts and then stalls: 504 within the deadline, and the body is torn down', async () => {
    const key = `items/${storeA.vendorId}/${opaque('.jpg')}`;
    stalledBody.add(key);
    bucket.set(key, { body: jpeg(21), contentType: 'image/jpeg' });
    await addItem(storeA.vendorId, storeA.categoryId, key);
    const started = Date.now();
    const res = await get(`/${key}`);
    expect(res.statusCode).toBe(504);
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS + 1500);
    expect(destroyed).toContain(key);
  });
});

describe('[PUBLIC-PHOTOS] photo names: what the upload saves is what is served', () => {
  it('an upload named "photo.jpg-large" is saved under the type its bytes are, and served', async () => {
    const item = await addItem(storeA.vendorId, storeA.categoryId, null);
    const stored = await uploadPhoto(app, storeA, item.id, 'photo.jpg-large', 'image/jpeg', jpeg(22));
    expect(stored).toMatch(new RegExp(`^items/${storeA.vendorId}/[A-Za-z0-9_-]{16}\\.jpg$`));
    expect((await get(`/${stored}`)).statusCode).toBe(200);
    // The bytes decide, not the name: PNG bytes called "menu.jpeg" are saved as .png.
    const png1 = await uploadPhoto(app, storeA, item.id, 'menu.jpeg', 'image/png', png(23));
    expect(png1).toMatch(/\.png$/);
  });

  it('a photo saved earlier under the uploaded file\'s own extension is still served', async () => {
    const key = `items/${storeA.vendorId}/${opaque('.jpg-large')}`;
    bucket.set(key, { body: jpeg(24), contentType: 'image/jpeg' });
    await addItem(storeA.vendorId, storeA.categoryId, key);
    const res = await get(`/${key}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });
});

describe('[PUBLIC-PHOTOS] the local provider answers the same address', () => {
  const dir = path.join(os.tmpdir(), `swift-public-photos-${nanoid(6)}`);
  let key = '';
  let orphanKey = '';
  let doc = '';
  beforeAll(async () => {
    key = `items/${storeB.vendorId}/${opaque('.png')}`;
    orphanKey = `items/${storeB.vendorId}/${opaque('.png')}`;
    await mkdir(path.join(dir, 'items', storeB.vendorId), { recursive: true });
    await writeFile(path.join(dir, key), png(11));
    await writeFile(path.join(dir, orphanKey), png(12));
    await addItem(storeB.vendorId, storeB.categoryId, key);
    // A private document on the same disk, and a store that typed a path
    // climbing out of its photo folder into it as an item's photo.
    doc = opaque('.png');
    await mkdir(path.join(dir, 'verification', storeB.userId), { recursive: true });
    await writeFile(path.join(dir, 'verification', storeB.userId, doc), png(13));
    await addItem(storeB.vendorId, storeB.categoryId, `items/${storeB.vendorId}/../../verification/${storeB.userId}/${doc}`);
    // The provider is chosen once, when the app is built — as the upload
    // routes choose theirs — so the local case gets its own app.
    process.env['STORAGE_PROVIDER'] = 'local';
    process.env['UPLOAD_DIR'] = dir;
    local = await buildApp();
    await local.ready();
  });
  afterAll(async () => {
    process.env['STORAGE_PROVIDER'] = 's3';
    if (priorEnv['UPLOAD_DIR'] === undefined) delete process.env['UPLOAD_DIR']; else process.env['UPLOAD_DIR'] = priorEnv['UPLOAD_DIR'];
    await rm(dir, { recursive: true, force: true });
  });

  it('a referenced photo on disk is served from the upload directory; an unreferenced one is not', async () => {
    const res = await local!.inject({ method: 'GET', url: `/${key}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(png(11))).toBe(true);
    const orphan = await local!.inject({ method: 'GET', url: `/${orphanKey}` });
    expect(orphan.statusCode).toBe(404);
  });

  it('the address a real local upload returns (/uploads/items/…) is served while the store uses the photo, and not after', async () => {
    const item = await addItem(storeB.vendorId, storeB.categoryId, null);
    const first = await uploadPhoto(local!, storeB, item.id, 'dish.png', 'image/png', png(14));
    expect(first).toMatch(new RegExp(`^/uploads/items/${storeB.vendorId}/[A-Za-z0-9_-]{16}\\.png$`));
    const res = await local!.inject({ method: 'GET', url: first });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe(HOUR);
    const before = await photoLookups();
    const second = await uploadPhoto(local!, storeB, item.id, 'dish.png', 'image/png', png(15));
    expect((await local!.inject({ method: 'GET', url: second })).statusCode).toBe(200);
    // The replaced photo's file is still on disk, but the store no longer uses it.
    const old = await local!.inject({ method: 'GET', url: first });
    expect(old.statusCode).toBe(404);
    expect(old.headers['cache-control']).toBe('no-store');
    expect(await photoLookups(), 'the local address must go through the same check').toBeGreaterThan(before);
  });

  it('the review pack\'s drawn pictures keep their own rule on the local address', async () => {
    expect((await local!.inject({ method: 'GET', url: '/uploads/items/review-pack/v1/no-such-store--pepperpot.png' })).statusCode).toBe(404);
  });

  it('a climbing path a store typed as its photo never reaches a document on the same disk', async () => {
    for (const url of [
      `/items/${storeB.vendorId}/..%2F..%2Fverification%2F${storeB.userId}%2F${doc}`,
      `/items/${storeB.vendorId}/../../verification/${storeB.userId}/${doc}`,
    ]) {
      const res = await local!.inject({ method: 'GET', url });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.rawPayload.equals(png(13)), url).toBe(false);
    }
  });
});
