import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { attributionRoutes } from '../modules/qr/attribution.routes';
import { AttributionService } from '../modules/qr/attribution.service';
import { QrService } from '../modules/qr/qr.service';
import { computeFpHash, normalizeIpForFp, parseInstallReferrer, playStoreUrlFor, uaMajorFamily } from '../modules/qr/attribution';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] this suite installs its partial unique index by raw DDL on a db-push database (migrations carry it in CI) — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// Install attribution (spec 4.3 / 12.3). The two laws under test everywhere:
// Android referrer is deterministic; iOS matches exactly ONE candidate or the
// app opens Home — including the same-café-Wi-Fi collision (edge row 13) and
// the claim race. Fingerprints are server-computed and ephemeral.
// ---------------------------------------------------------------------------

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A155F) Mobile Safari/537.36';

let app: FastifyInstance;
let qrService: QrService;
let attribution: AttributionService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_860_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeLiveVendorCode(): Promise<{ vendorId: string; slug: string; code: string }> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Attr', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Attr Vendor ${seq}`, slug: `attr-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Claim Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const qr = await qrService.getOrCreateForVendor(vendor.id, user.id);
  return { vendorId: vendor.id, slug: vendor.slug, code: qr.shortCode };
}

const postIntent = (body: unknown, ip: string, ua: string) =>
  app.inject({ method: 'POST', url: '/api/v1/attribution/intent', payload: body as object, remoteAddress: ip, headers: { 'user-agent': ua } });

const postClaim = (body: unknown, ip: string, ua: string) =>
  app.inject({ method: 'POST', url: '/api/v1/attribution/claim', payload: body as object, remoteAddress: ip, headers: { 'user-agent': ua } });

beforeAll(async () => {
  process.env['APP_STORE_URL'] = 'https://apps.apple.com/app/id0000000000';
  process.env['PLAY_STORE_URL'] = 'https://play.google.com/store/apps/details';
  process.env['ANDROID_PACKAGE_ID'] = 'gy.swift.app';

  app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 500, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  registerErrorHandler(app);
  await app.register(attributionRoutes, { prefix: '/api/v1/attribution' });
  await app.ready();

  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "one_active_qr_per_entity" ON "qr_codes"("tenantId", "entityType", "entityId") WHERE status = 'ACTIVE'`,
  );
  qrService = new QrService(app.prisma);
  attribution = new AttributionService(app.prisma);
});

afterAll(async () => {
  await app.prisma.pendingAttribution.deleteMany({ where: { destinationPath: { startsWith: '/store/attr-vendor-' } } });
  await app.prisma.attributionClaim.deleteMany({ where: { installId: { startsWith: 'inst-' } } });
  await app.prisma.scanEvent.deleteMany({ where: { qrCode: { entityId: { in: createdVendorIds } } } });
  await app.prisma.qrCode.deleteMany({ where: { entityId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('pure pieces', () => {
  it('fingerprint: IPv4 whole, IPv6 /64, iOS major family; salt never leaks raw parts', () => {
    expect(normalizeIpForFp('190.80.12.34')).toBe('190.80.12.34');
    expect(normalizeIpForFp('2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff')).toBe('2001:db8:aaaa:bbbb');
    expect(normalizeIpForFp('::ffff:10.0.0.7')).toBe('10.0.0.7');
    expect(uaMajorFamily(IOS_UA)).toBe('iOS-17');
    expect(uaMajorFamily(ANDROID_UA)).toBe('android');
    const fp = computeFpHash('190.80.12.34', IOS_UA);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.includes('190.80')).toBe(false);
  });

  it('referrer parse: decoded Play payload → code+template; garbage → null', () => {
    expect(parseInstallReferrer('swift_qr=BCDFGHJKMN&t=sticker')).toEqual({ code: 'BCDFGHJKMN', template: 'sticker' });
    expect(parseInstallReferrer('swift_qr=bcdfghjkmn')).toEqual({ code: 'BCDFGHJKMN', template: null });
    expect(parseInstallReferrer('utm_source=organic')).toBeNull();
    expect(parseInstallReferrer('swift_qr=NOT!VALID')).toBeNull();
    expect(parseInstallReferrer('')).toBeNull();
  });

  it('play URL: referrer value URL-encoded exactly once', () => {
    expect(playStoreUrlFor('BCDFGHJKMN', 'sticker')).toBe(
      'https://play.google.com/store/apps/details?id=gy.swift.app&referrer=swift_qr%3DBCDFGHJKMN%26t%3Dsticker',
    );
  });
});

describe('POST /attribution/intent', () => {
  it('iOS tap files ONE candidate with a server-computed fingerprint and returns the App Store URL', async () => {
    const { code, slug } = await makeLiveVendorCode();
    const ip = '198.51.100.11';

    const res = await postIntent({ shortCode: code.toLowerCase(), fpHash: 'client-supplied-garbage' }, ip, IOS_UA);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.storeUrl).toBe(process.env['APP_STORE_URL']);

    const rows = await app.prisma.pendingAttribution.findMany({ where: { destinationPath: `/store/${slug}` } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fpHash).toBe(computeFpHash(ip, IOS_UA)); // server-derived, client input ignored
    expect(rows[0]!.platform).toBe('ios');
    const ttlMs = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(Math.round(ttlMs / 60_000)).toBe(30);
  });

  it('caps open candidates per fingerprint at 3, oldest out', async () => {
    const { code } = await makeLiveVendorCode();
    const ip = '198.51.100.12';
    for (let i = 0; i < 4; i += 1) await postIntent({ shortCode: code }, ip, IOS_UA);
    const rows = await app.prisma.pendingAttribution.findMany({ where: { fpHash: computeFpHash(ip, IOS_UA) } });
    expect(rows).toHaveLength(3);
  });

  it('Android tap files NO row and returns the referrer-tagged Play URL', async () => {
    const { code, slug } = await makeLiveVendorCode();
    const res = await postIntent({ shortCode: code, t: 'flyer' }, '198.51.100.13', ANDROID_UA);
    expect(res.json().data.storeUrl).toBe(
      `https://play.google.com/store/apps/details?id=gy.swift.app&referrer=swift_qr%3D${code}%26t%3Dflyer`,
    );
    expect(await app.prisma.pendingAttribution.count({ where: { destinationPath: `/store/${slug}` } })).toBe(0);
  });

  it('retired/unknown codes earn no attribution', async () => {
    const { code, vendorId } = await makeLiveVendorCode();
    await qrService.deactivateForVendor(vendorId);
    expect((await postIntent({ shortCode: code }, '198.51.100.14', IOS_UA)).statusCode).toBe(404);
    expect((await postIntent({ shortCode: 'BCDFGHJKMN' }, '198.51.100.14', IOS_UA)).statusCode).toBe(404);
  });
});

describe('POST /attribution/claim', () => {
  it('Android referrer is deterministic; the receipt makes re-claims idempotent', async () => {
    const { code, slug } = await makeLiveVendorCode();
    const installId = `inst-${nanoid(10)}`;

    const first = await postClaim({ installId, platform: 'android', referrer: `swift_qr=${code}&t=card` }, '203.0.113.31', ANDROID_UA);
    expect(first.json().data.destination).toBe(`/store/${slug}`);
    expect(first.json().data.tenantHint).toBe('swift-default');

    // Re-claim with a DIFFERENT (now missing) referrer: the receipt answers.
    const again = await postClaim({ installId, platform: 'android' }, '203.0.113.32', ANDROID_UA);
    expect(again.json().data.destination).toBe(`/store/${slug}`);

    const receipt = await app.prisma.attributionClaim.findUnique({ where: { installId } });
    expect(receipt?.outcome).toBe('deterministic');
  });

  it('Android without a parsable referrer (sideload/organic) goes Home', async () => {
    const res = await postClaim({ installId: `inst-${nanoid(10)}`, platform: 'android', referrer: 'utm_source=friend' }, '203.0.113.33', ANDROID_UA);
    expect(res.json().data.destination).toBeNull();
  });

  it('iOS: exactly one candidate → the store; the row records the claim', async () => {
    const { code, slug } = await makeLiveVendorCode();
    const ip = '203.0.113.41';
    await postIntent({ shortCode: code }, ip, IOS_UA);

    const installId = `inst-${nanoid(10)}`;
    const res = await postClaim({ installId, platform: 'ios' }, ip, IOS_UA);
    expect(res.json().data.destination).toBe(`/store/${slug}`);

    const row = await app.prisma.pendingAttribution.findFirstOrThrow({ where: { fpHash: computeFpHash(ip, IOS_UA) } });
    expect(row.claimedAt).not.toBeNull();
    expect(row.claimedInstallId).toBe(installId);
  });

  it('iOS: two candidates on one fingerprint (same café Wi-Fi) → BOTH go Home, rows stay unclaimed', async () => {
    const a = await makeLiveVendorCode();
    const b = await makeLiveVendorCode();
    const ip = '203.0.113.42';
    await postIntent({ shortCode: a.code }, ip, IOS_UA);
    await postIntent({ shortCode: b.code }, ip, IOS_UA);

    const one = await postClaim({ installId: `inst-${nanoid(10)}`, platform: 'ios' }, ip, IOS_UA);
    const two = await postClaim({ installId: `inst-${nanoid(10)}`, platform: 'ios' }, ip, IOS_UA);
    expect(one.json().data.destination).toBeNull();
    expect(two.json().data.destination).toBeNull();
    const rows = await app.prisma.pendingAttribution.findMany({ where: { fpHash: computeFpHash(ip, IOS_UA) } });
    expect(rows.every((r) => r.claimedAt === null)).toBe(true);
  });

  it('iOS: expired candidate → Home', async () => {
    const { code } = await makeLiveVendorCode();
    const ip = '203.0.113.43';
    await postIntent({ shortCode: code }, ip, IOS_UA);
    await app.prisma.pendingAttribution.updateMany({
      where: { fpHash: computeFpHash(ip, IOS_UA) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await postClaim({ installId: `inst-${nanoid(10)}`, platform: 'ios' }, ip, IOS_UA);
    expect(res.json().data.destination).toBeNull();
  });

  it('iOS claim race: one candidate, two parallel claims → exactly one wins', async () => {
    const { code, slug } = await makeLiveVendorCode();
    const ip = '203.0.113.44';
    await postIntent({ shortCode: code }, ip, IOS_UA);

    const [r1, r2] = await Promise.all([
      attribution.claim(`inst-${nanoid(10)}`, 'ios', undefined, { ip, ua: IOS_UA }),
      attribution.claim(`inst-${nanoid(10)}`, 'ios', undefined, { ip, ua: IOS_UA }),
    ]);
    const destinations = [r1.destination, r2.destination];
    expect(destinations.filter((d) => d === `/store/${slug}`)).toHaveLength(1);
    expect(destinations.filter((d) => d === null)).toHaveLength(1);
  });

  it('claim is rate limited per IP (5/min)', async () => {
    const ip = '192.0.2.99';
    let limited = false;
    for (let i = 0; i < 6; i += 1) {
      const res = await postClaim({ installId: `inst-${nanoid(10)}`, platform: 'android' }, ip, ANDROID_UA);
      if (res.statusCode === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});

describe('purge job', () => {
  it('hard-deletes expired fingerprints, keeps live ones', async () => {
    const { code } = await makeLiveVendorCode();
    const ipLive = '203.0.113.51';
    const ipDead = '203.0.113.52';
    await postIntent({ shortCode: code }, ipLive, IOS_UA);
    await postIntent({ shortCode: code }, ipDead, IOS_UA);
    await app.prisma.pendingAttribution.updateMany({
      where: { fpHash: computeFpHash(ipDead, IOS_UA) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const purged = await attribution.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await app.prisma.pendingAttribution.count({ where: { fpHash: computeFpHash(ipDead, IOS_UA) } })).toBe(0);
    expect(await app.prisma.pendingAttribution.count({ where: { fpHash: computeFpHash(ipLive, IOS_UA) } })).toBe(1);
  });
});
