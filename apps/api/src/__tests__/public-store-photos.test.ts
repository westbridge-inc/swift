import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';

// ---------------------------------------------------------------------------
// [IMAGES-E2E] A store's uploaded photo reaches customers.
//
// Staging and production keep uploads in a PRIVATE object-storage bucket, and the
// upload saves the bare key ("items/<store>/<file>"). Both apps put the API
// origin in front of it, so a customer's phone asks for "<api>/items/<store>/<file>".
// Before this, nothing answered that address (404): no store photo ever showed.
//
// The storage provider here behaves exactly like the S3 adapter for these purposes:
// upload returns the bare key, the bytes are private and readable only through
// the provider.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const objects = new Map<string, Buffer>();
  const stats = { reads: 0 };
  const provider = {
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
      // Like the local adapter, which resolves the key as a path: a key that climbs reaches the folder it names.
      const { posix } = require('node:path') as typeof import('node:path');
      const b = objects.get(posix.normalize(key));
      return b && b.length <= maxBytes ? b : null;
    },
  };
  return provider;
});

vi.mock('../providers/storage/storage-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/storage/storage-provider')>()),
  getStorageProvider: () => fake,
}));

import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { publicRoutes } from '../modules/public/public.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicStorePhotos, resetStorePhotoCachesForTests } from '../utils/public-store-photos';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];

async function makeOwner(): Promise<{ userId: string; ownerId: string; token: string }> {
  const roles: UserRole[] = ['VENDOR_OWNER'];
  const user = await app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Photo', lastName: 'Owner', roles, activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'photo-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  return { userId: user.id, ownerId: owner.id, token };
}

async function makeStore(ownerId: string, overrides: Record<string, unknown> = {}) {
  const tag = wordFreeTag(8).toLowerCase();
  const v = await app.prisma.vendor.create({
    data: {
      ownerId, name: `Photo Store ${tag}`, slug: `photo-store-${tag}`, vendorType: 'RESTAURANT',
      phone: '+5926990001', addressLine1: '1 Photo Street', city: 'Georgetown', region: 'Demerara',
      latitude: 6.8, longitude: -58.16, status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
      ...overrides,
    },
  });
  vendorIds.push(v.id);
  return v;
}

async function makeItem(vendorId: string, imageUrl: string | null, overrides: Record<string, unknown> = {}) {
  const cat = await app.prisma.category.create({ data: { vendorId, name: `Mains ${wordFreeTag(4)}`, sortOrder: 0 } });
  return app.prisma.item.create({
    data: { vendorId, categoryId: cat.id, name: `Plate ${wordFreeTag(6)}`, basePrice: 1500, isAvailable: true, imageUrl, ...overrides },
  });
}

/** Where the camera stood (made up): what the GPS block and the XMP packet below carry. */
const XMP_PLACE = '6,48.5208N';
const XMP_PACKET = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + `<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="${XMP_PLACE}"/></rdf:RDF></x:xmpmeta>`;

/** A camera photo: 2000x1200, EXIF naming the phone AND a GPS block, an XMP packet with
 *  the place, rotated by its orientation tag, a P3 colour profile. It goes into the bucket
 *  directly (stash), past the upload's own strip: the door must not rely on that strip. */
async function cameraJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2000, height: 1200, channels: 3, background: { r: 200, g: 40, b: 30 } } })
    .withExif({
      IFD0: { Make: 'SecretMaker', Model: 'SecretPhoneModel', Copyright: 'Jane Private' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 48/1 3125/100', GPSLongitudeRef: 'W', GPSLongitude: '58/1 9/1 3600/100' },
    })
    .withXmp(XMP_PACKET)
    .withMetadata({ orientation: 6 })
    .withIccProfile('p3')
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** The EXIF tag that points at a GPS block (0x8825), in either byte order. */
const hasGpsBlock = (exif: Buffer | undefined) => !!exif && (exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88])));

/** Put bytes in the private bucket under a key, as an upload would have. */
function stash(key: string, bytes: Buffer): string {
  fake.objects.set(key, bytes);
  return key;
}
const photoName = () => `${nanoid(16).replace(/[^A-Za-z0-9_-]/g, 'x')}.jpg`;

let owner: Awaited<ReturnType<typeof makeOwner>>;
let store: Awaited<ReturnType<typeof makeStore>>;

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  registerPublicStorePhotos(app, fake);
  await app.ready();
  owner = await makeOwner();
  store = await makeStore(owner.ownerId);
});

beforeEach(() => { resetStorePhotoCachesForTests(); fake.stats.reads = 0; });

afterAll(async () => {
  if (vendorIds.length) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  }
  if (userIds.length) await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

describe('a store uploads a photo; the customer sees it', () => {
  it('the photo the store uploads is fetchable at the address the customer API hands out', async () => {
    const item = await makeItem(store.id, null);
    const boundary = `----swift${nanoid(8)}`;
    const jpeg = await cameraJpeg();
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="dish.jpg"\r\ncontent-type: image/jpeg\r\n\r\n`),
      jpeg, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST', url: `/api/v1/vendor/items/${item.id}/image`, payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${owner.token}` },
    });
    expect(up.statusCode).toBe(200);
    const stored = up.json().data.imageUrl as string;
    expect(stored).toMatch(new RegExp(`^items/${store.id}/[A-Za-z0-9_-]{16}\\.jpg$`)); // a bare key, as on staging

    // The customer read (the public storefront the website and guests use) hands the key out…
    const page = await get(`/api/v1/public/storefronts/${store.slug}`);
    expect(page.statusCode).toBe(200);
    const served = (page.json().data.categories as Array<{ items: Array<{ id: string; imageUrl: string | null }> }>)
      .flatMap((c) => c.items).find((i) => i.id === item.id)?.imageUrl;
    expect(served).toBe(stored);

    // …and the address both apps build from it answers with the picture.
    const res = await get(`/${served}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('serves the picture upright, at most 1600 px, with NO metadata: no EXIF, no GPS block, no ICC profile, no device name', async () => {
    const stored = await cameraJpeg();
    // The stored object itself still carries all of it (as if the upload strip had missed it).
    const before = await sharp(stored).metadata();
    expect(hasGpsBlock(before.exif)).toBe(true);
    expect(before.xmp?.toString()).toContain(XMP_PLACE);
    expect(before.icc).toBeDefined();
    const key = stash(`items/${store.id}/${photoName()}`, stored);
    await makeItem(store.id, key);
    const res = await get(`/${key}`);
    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.rawPayload).metadata();
    // orientation 6 = the camera held upright: the 2000x1200 sensor image is drawn 1200 wide, 2000 tall, then capped.
    expect(meta.width).toBe(960);
    expect(meta.height).toBe(1600);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    for (const secret of ['SecretMaker', 'SecretPhoneModel', 'Jane Private', 'Display P3', XMP_PLACE, 'adobe:ns:meta', 'Exif\0\0']) {
      expect(res.rawPayload.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it('serves a list thumbnail from a fixed ladder of widths, and refuses any other width or parameter', async () => {
    const key = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    await makeItem(store.id, key);
    const thumb = await get(`/${key}?w=320`);
    expect(thumb.statusCode).toBe(200);
    const thumbMeta = await sharp(thumb.rawPayload).metadata();
    expect(thumbMeta.width).toBe(320);
    expect([thumbMeta.exif, thumbMeta.xmp, thumbMeta.icc, thumbMeta.iptc]).toEqual([undefined, undefined, undefined, undefined]);
    expect(thumb.rawPayload.length).toBeLessThan(60_000);
    for (const bad of ['?w=333', '?w=99999', '?w=320&x=1', '?q=1']) {
      const res = await get(`/${key}${bad}`);
      expect(res.statusCode).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('is cacheable for a day with an ETag, answers 304 without reading storage, and may be embedded by the website', async () => {
    const key = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    await makeItem(store.id, key);
    const first = await get(`/${key}?w=480`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('public, max-age=86400, immutable');
    expect(first.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    const etag = first.headers['etag'] as string;
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    const reads = fake.stats.reads;
    const again = await get(`/${key}?w=480`, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(fake.stats.reads).toBe(reads);
    // A different width is a different picture: never the same ETag.
    expect((await get(`/${key}?w=640`)).headers['etag']).not.toBe(etag);
  });

  it('PNG and WebP photos keep their type', async () => {
    const draw = () => sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 10, g: 120, b: 60 } } });
    for (const [bytes, type] of [[await draw().png().toBuffer(), 'image/png'], [await draw().webp().toBuffer(), 'image/webp']] as const) {
      const key = stash(`items/${store.id}/${photoName()}`, bytes);
      await makeItem(store.id, key);
      const res = await get(`/${key}?w=640`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(type);
      const drawn = await sharp(res.rawPayload).metadata();
      expect(drawn.format).toBe(type.slice('image/'.length));
      expect(drawn.width).toBe(640);
    }
  });

  it('the store\'s logo and cover and a menu section picture are served the same way', async () => {
    const logo = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    const cover = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    const section = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    await app.prisma.vendor.update({ where: { id: store.id }, data: { logoUrl: logo, coverImageUrl: cover } });
    await app.prisma.category.create({ data: { vendorId: store.id, name: `Drinks ${wordFreeTag(4)}`, imageUrl: section } });
    for (const key of [logo, cover, section]) {
      for (const address of [`/${key}?w=160`, `/${key}`]) {
        const res = await get(address);
        expect(res.statusCode).toBe(200);
        const meta = await sharp(res.rawPayload).metadata();
        expect([meta.exif, meta.xmp, meta.icc, meta.iptc]).toEqual([undefined, undefined, undefined, undefined]);
        expect(res.rawPayload.includes(Buffer.from(XMP_PLACE))).toBe(false);
      }
    }
  });
});

describe('only a photo a visible store still shows; nothing else in the bucket', () => {
  const refused = async (url: string) => {
    const res = await get(url);
    expect(res.statusCode, url).toBe(404);
    // The door's refusal is never cached; an address outside /items/<store>/<file> is not routed at all.
    if (url.startsWith('/items/') && !url.slice('/items/'.length).includes('%')) expect(res.headers['cache-control'], url).toBe('no-store');
    expect(res.headers['content-type'] ?? '').not.toMatch(/^image\//);
    expect(res.rawPayload.length).toBeLessThan(200);
  };

  it('an identity document is never reachable, whatever the address or a row says', async () => {
    const file = photoName();
    const kyc = stash(`verification/${owner.userId}/${file}`, await cameraJpeg());
    // Even a store row pointing at it (a free-text field) publishes nothing.
    await makeItem(store.id, kyc);
    await app.prisma.vendor.update({ where: { id: store.id }, data: { coverImageUrl: kyc } });
    await refused(`/${kyc}`);
    await refused(`/items/${store.id}/${file}`);
    await refused(`/items/${store.id}/..%2F..%2F${kyc.replace(/\//g, '%2F')}`);
    await refused(`/items/..%2Fverification%2F${owner.userId}/${file}`);
    await refused(`/items/${store.id}/${file.replace('.jpg', '')}.jpg%00.png`);
    await app.prisma.vendor.update({ where: { id: store.id }, data: { coverImageUrl: null } });
  });

  it('a photo in the bucket that no row of the store references is refused, and so is one only ANOTHER store references', async () => {
    const orphan = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    await refused(`/${orphan}`);
    const other = await makeStore(owner.ownerId);
    const borrowed = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    await makeItem(other.id, borrowed); // another store typed this store's key into its row
    await refused(`/${borrowed}`);
  });

  it('a deleted (archived) item\'s photo is refused', async () => {
    const key = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    await makeItem(store.id, key, { archivedAt: new Date(), isAvailable: false });
    await refused(`/${key}`);
  });

  it('a suspended, unapproved or wound-down store publishes nothing, nor one whose owner closed the account', async () => {
    const cases: Array<{ store?: Record<string, unknown>; ownerStatus?: 'DEACTIVATED' | 'SUSPENDED' }> = [
      { store: { status: 'SUSPENDED' } },
      { store: { status: 'PENDING_APPROVAL', isVerified: false } },
      { store: { isVerified: false } },
      { ownerStatus: 'DEACTIVATED' },
      { ownerStatus: 'SUSPENDED' },
    ];
    for (const c of cases) {
      const o = await makeOwner();
      const s = await makeStore(o.ownerId, c.store ?? {});
      if (c.ownerStatus) await app.prisma.user.update({ where: { id: o.userId }, data: { status: c.ownerStatus } });
      const key = stash(`items/${s.id}/${photoName()}`, await cameraJpeg());
      await makeItem(s.id, key);
      await refused(`/${key}`);
    }
  });

  it('a store suspended after its photo was served stops being served once the short decision window passes', async () => {
    const o = await makeOwner();
    const s = await makeStore(o.ownerId);
    const key = stash(`items/${s.id}/${photoName()}`, await cameraJpeg());
    await makeItem(s.id, key);
    expect((await get(`/${key}`)).statusCode).toBe(200);
    await app.prisma.vendor.update({ where: { id: s.id }, data: { status: 'SUSPENDED' } });
    resetStorePhotoCachesForTests(); // the 30 s window, elapsed
    await refused(`/${key}`);
  });

  it('a row holding a key that climbs out of the folder cannot climb: the address is refused before any read', async () => {
    const file = photoName();
    const kyc = stash(`verification/${owner.userId}/${file}`, await cameraJpeg());
    const climbing = `items/${store.id}/../../verification/${owner.userId}/${file}`;
    await makeItem(store.id, climbing); // a free-text field accepts any string today
    const reads = fake.stats.reads;
    await refused(`/items/${store.id}/..%2F..%2Fverification%2F${owner.userId}%2F${file}`);
    await refused(`/items/${store.id}/${encodeURIComponent(`../../${kyc}`)}`);
    expect(fake.stats.reads).toBe(reads);
  });

  it('a photo only a banned or held item shows is refused; one a live item also shows is served', async () => {
    const key = stash(`items/${store.id}/${photoName()}`, await cameraJpeg());
    await makeItem(store.id, key, { name: `Mango Vape Pen ${wordFreeTag(4)}` });
    await refused(`/${key}`);
    await makeItem(store.id, key);
    resetStorePhotoCachesForTests();
    expect((await get(`/${key}`)).statusCode).toBe(200);
  });

  it('a store held for its own words (a name about banned goods) publishes nothing', async () => {
    const o = await makeOwner();
    const s = await makeStore(o.ownerId, { name: `Ron's Liquor Store ${wordFreeTag(6)}` });
    const key = stash(`items/${s.id}/${photoName()}`, await cameraJpeg());
    await makeItem(s.id, key);
    await refused(`/${key}`);
    // Its logo is guarded by the store's own hold alone (no item check stands in front of it).
    const logo = stash(`items/${s.id}/${photoName()}`, await cameraJpeg());
    await app.prisma.vendor.update({ where: { id: s.id }, data: { logoUrl: logo } });
    await refused(`/${logo}`);
  });

  it('a referenced key whose bytes are not a photo is refused', async () => {
    const key = stash(`items/${store.id}/${photoName()}`, Buffer.from('%PDF-1.7 not a photo at all, padded to be long enough'));
    await makeItem(store.id, key);
    await refused(`/${key}`);
  });
});

// ---------------------------------------------------------------------------
// [IMAGES-E2E PR2] A store uploads its own logo and cover. Every store photo (menu
// item, logo, cover) is kept REDRAWN: upright, at most 1600 px, no metadata at all.
// The bucket here keeps exactly what the route hands it (it skips the storage seam's
// own strip), so a clean stored object proves the route's redraw itself.
// ---------------------------------------------------------------------------

function multipartPhoto(bytes: Buffer, filename: string, type: string) {
  const boundary = `----swift${nanoid(8)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${type}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function uploadTo(url: string, token: string, bytes: Buffer, filename = 'photo.jpg', type = 'image/jpeg') {
  const { payload, headers } = multipartPhoto(bytes, filename, type);
  return app.inject({ method: 'POST', url, payload, headers: { ...headers, authorization: `Bearer ${token}` } });
}

/** The stored object is a clean redraw: no EXIF/GPS/XMP/ICC/IPTC, none of the camera's words, long edge <= 1600. */
async function expectCleanStored(key: string) {
  const stored = fake.objects.get(key);
  expect(stored).toBeDefined();
  const meta = await sharp(stored!).metadata();
  expect([meta.exif, meta.xmp, meta.icc, meta.iptc, meta.orientation]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1600);
  for (const secret of ['SecretMaker', 'SecretPhoneModel', 'Jane Private', XMP_PLACE, 'Exif\0\0']) {
    expect(stored!.includes(Buffer.from(secret))).toBe(false);
  }
}

describe('a store uploads its logo and cover; every store photo is kept redrawn', () => {
  it('a store manager uploads a logo and a cover: kept clean in the store photo folder, and the door serves them', async () => {
    const o = await makeOwner();
    const s = await makeStore(o.ownerId);
    for (const [slot, field] of [['logo', 'logoUrl'], ['cover', 'coverImageUrl']] as const) {
      const res = await uploadTo(`/api/v1/vendor/profile/${slot}`, o.token, await cameraJpeg());
      expect(res.statusCode).toBe(200);
      const key = res.json().data[field] as string;
      expect(key).toMatch(new RegExp(`^items/${s.id}/[A-Za-z0-9_-]{16}\\.jpg$`));
      expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.id } }))[field]).toBe(key);
      await expectCleanStored(key);
      const served = await get(`/${key}?w=320`);
      expect(served.statusCode).toBe(200);
      expect((await sharp(served.rawPayload).metadata()).width).toBe(320);
    }
  });

  it('a PNG logo stays a PNG', async () => {
    const o = await makeOwner();
    await makeStore(o.ownerId);
    const png = await sharp({ create: { width: 2400, height: 2400, channels: 4, background: { r: 0, g: 90, b: 200, alpha: 0.5 } } }).png().toBuffer();
    const res = await uploadTo('/api/v1/vendor/profile/logo', o.token, png, 'logo.png', 'image/png');
    expect(res.statusCode).toBe(200);
    const key = res.json().data.logoUrl as string;
    expect(key.endsWith('.png')).toBe(true);
    const meta = await sharp(fake.objects.get(key)!).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(1600);
  });

  it('a menu item photo is kept redrawn the same way', async () => {
    const item = await makeItem(store.id, null);
    const res = await uploadTo(`/api/v1/vendor/items/${item.id}/image`, owner.token, await cameraJpeg());
    expect(res.statusCode).toBe(200);
    await expectCleanStored(res.json().data.imageUrl as string);
  });

  it('taking the logo down stops the door serving it', async () => {
    const o = await makeOwner();
    const s = await makeStore(o.ownerId);
    const key = (await uploadTo('/api/v1/vendor/profile/logo', o.token, await cameraJpeg())).json().data.logoUrl as string;
    expect((await get(`/${key}`)).statusCode).toBe(200);
    const down = await app.inject({ method: 'DELETE', url: '/api/v1/vendor/profile/logo', headers: { authorization: `Bearer ${o.token}` } });
    expect(down.statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.id } })).logoUrl).toBeNull();
    resetStorePhotoCachesForTests();
    const gone = await get(`/${key}`);
    expect(gone.statusCode).toBe(404);
    expect(gone.headers['cache-control']).toBe('no-store');
  });

  it('a typed address cannot stand in for an uploaded photo; typed text may only take one down or repeat it', async () => {
    const o = await makeOwner();
    const s = await makeStore(o.ownerId);
    const other = await makeStore((await makeOwner()).ownerId);
    const key = (await uploadTo('/api/v1/vendor/profile/cover', o.token, await cameraJpeg())).json().data.coverImageUrl as string;
    const put = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', payload: body, headers: { authorization: `Bearer ${o.token}` } });
    for (const body of [
      { logoUrl: 'https://elsewhere.example/a.jpg' },
      { coverImageUrl: `items/${other.id}/${photoName()}` },
      { logoUrl: `items/${s.id}/../../verification/${o.userId}/${photoName()}` },
      { coverImageUrl: `/uploads/items/${s.id}/${photoName()}` },
    ]) {
      const res = await put(body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('STORE_PHOTO_UPLOAD_ONLY');
    }
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.id } })).coverImageUrl).toBe(key);
    expect((await put({ coverImageUrl: key })).statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.id } })).coverImageUrl).toBe(key);
    expect((await put({ coverImageUrl: '' })).statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.id } })).coverImageUrl).toBeNull();
  });

  it('a file that is not a photo is refused, and someone who is not the store cannot change its logo', async () => {
    const o = await makeOwner();
    const s = await makeStore(o.ownerId);
    const notPhoto = await uploadTo('/api/v1/vendor/profile/logo', o.token, Buffer.from('#!/bin/sh\necho hi\n'.repeat(4)), 'logo.png', 'image/png');
    expect(notPhoto.statusCode).toBe(400);
    expect(notPhoto.json().error.code).toBe('BAD_IMAGE');
    const gif = await uploadTo('/api/v1/vendor/profile/logo', o.token, Buffer.from('GIF89a'), 'logo.gif', 'image/gif');
    expect(gif.json().error.code).toBe('BAD_IMAGE_TYPE');
    const user = await app.prisma.user.create({
      data: { phone: testPhone(), firstName: 'Just', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'photo-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    const outsider = await uploadTo('/api/v1/vendor/profile/logo', token, await cameraJpeg());
    expect(outsider.statusCode).toBeGreaterThanOrEqual(401);
    expect(outsider.statusCode).toBeLessThan(500);
    const outsiderDelete = await app.inject({ method: 'DELETE', url: '/api/v1/vendor/profile/cover', headers: { authorization: `Bearer ${token}` } });
    expect(outsiderDelete.statusCode).toBeGreaterThanOrEqual(401);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: s.id } })).logoUrl).toBeNull();
  });
});
