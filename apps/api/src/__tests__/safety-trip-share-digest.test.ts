import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import { TripShareService, tripShareDigest, rotateLegacyTripShareTokens } from '../modules/safety/trip-share.service';
import { NotificationService } from '../modules/notification/notification.service';
import type { NotificationChannels } from '../../src/providers/notifications/channels';

// Trip Share (safety spec §6). The laws under test: the token is unguessable
// and grants ONLY the narrow public payload (no addresses, no phones, no ids,
// passenger FIRST NAME only); invalid/revoked/expired are one
// indistinguishable null; the share dies at trip end + grace; a stranger
// cannot mint for someone else's trip (404-by-absence).

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382', { db: 15 });

const sent: Array<{ to: string; body: string }> = [];
const channels = {
  sms: { sendSms: async (to: string, body: string) => { sent.push({ to, body }); return { ref: 't' }; } },
} as unknown as NotificationChannels;

const svc = new TripShareService(prisma, redis, channels);

const userIds: string[] = [];
const orderIds: string[] = [];
const driverIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_870_000_000 + Math.floor(Math.random() * 9_000_000);

async function mkUser(first: string, roles: ('CUSTOMER' | 'DRIVER')[] = ['CUSTOMER']) {
  seq += 1;
  const u = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: first, lastName: 'ShareTest', roles, activeRole: roles[0]!, isPhoneVerified: true },
  });
  userIds.push(u.id);
  return u;
}

async function mkTrip(opts: { status?: string; withDriver?: boolean } = {}) {
  const customer = await mkUser('Asha');
  let driverId: string | null = null;
  if (opts.withDriver !== false) {
    const driverUser = await mkUser('Deo', ['DRIVER']);
    const driver = await prisma.driver.create({
      data: {
        userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019,
        vehicleColor: 'Silver', licensePlate: `PAB ${Math.floor(1000 + Math.random() * 8999)}`,
        driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
        currentLat: 6.8013, currentLng: -58.1553, lastLocationUpdate: new Date(),
      },
    });
    driverIds.push(driver.id);
    driverId = driver.id;
  }
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      orderType: 'TAXI',
      status: (opts.status ?? 'RIDE_IN_PROGRESS') as never,
      orderNumber: `TS-${nanoid(8)}`,
      fulfillment: 'DELIVERY',
      pickupAddress: 'Stabroek Market', pickupLat: 6.8045, pickupLng: -58.1622,
      deliveryAddress: '123 Secret Street, Georgetown',
      deliveryLat: 6.8145, deliveryLng: -58.1522,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0,
      totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
      ...(driverId ? { driverId } : {}),
    },
  });
  orderIds.push(order.id);
  return { customer, order };
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  redis.disconnect();
});


// ---------------------------------------------------------------------------
// [S-16] Trip-share bearer token is stored in plaintext.
//
// The register's red test: a database row cannot be used directly as the
// token; the constant-time digest lookup succeeds only with the original
// secret. Around it: the secret is high-entropy and returned once; revocation
// by secret; the public read is throttled per token and per caller; a caller
// that keeps guessing is blocked (enumeration); legacy plaintext rows are
// rotated (revoked, nulled, the sharer told) and never read as plaintext; the
// rollback disables public lookup and never restores plaintext.
// ---------------------------------------------------------------------------

const rowByDigest = (secret: string) => prisma.tripShareToken.findUniqueOrThrow({ where: { tokenDigest: tripShareDigest(secret) } });

describe('[S-16] only a digest is stored', () => {
  it('the register’s red test: the row holds no plaintext and cannot be used as the token; the lookup succeeds only with the original secret', async () => {
    const { customer, order } = await mkTrip();
    const share = await svc.mint(customer.id, order.id);
    expect(share.token.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    const row = await rowByDigest(share.token);
    expect(row.token).toBeNull();
    expect(row.tokenDigest).toBe(tripShareDigest(share.token));
    expect(row.tokenPrefix).toBe(share.token.slice(0, 6));
    // the stored digest is not a token
    expect(await svc.publicView(row.tokenDigest!)).toBeNull();
    // a near miss is not a token
    expect(await svc.publicView(share.token.slice(0, -1) + (share.token.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(await svc.publicView(share.token)).not.toBeNull();
    // revocation is by secret too; the digest cannot revoke
    await expect(svc.revoke(customer.id, row.tokenDigest!)).rejects.toMatchObject({ statusCode: 404 });
    await svc.revoke(customer.id, share.token);
    expect(await svc.publicView(share.token)).toBeNull();
    expect(await prisma.tripShareToken.count({ where: { orderId: order.id, token: { not: null } } })).toBe(0);
  });

  it('the public read is throttled per token, and a caller that keeps guessing is blocked', async () => {
    const { customer, order } = await mkTrip();
    const share = await svc.mint(customer.id, order.id);
    const caller = `ip-${Date.now()}`;
    let ok = 0;
    for (let i = 0; i < 65; i += 1) if (await svc.publicView(share.token, new Date(), caller)) ok += 1;
    expect(ok).toBe(60);
    // enumeration: twenty-one invalid guesses from one caller block that caller for ten minutes
    const guesser = `ip-guess-${Date.now()}`;
    for (let i = 0; i < 21; i += 1) expect(await svc.publicView(`guess-${i}-${'x'.repeat(40)}`, new Date(), guesser)).toBeNull();
    expect(await redis.get(`tripshare:blocked:${guesser}`)).toBe('1');
    const other = await svc.mint(customer.id, order.id);
    expect(await svc.publicView(other.token, new Date(), guesser)).toBeNull(); // blocked, even with a valid secret
    expect(await svc.publicView(other.token, new Date(), `ip-fresh-${Date.now()}`)).not.toBeNull();
  });
});

describe('[S-16] legacy plaintext is rotated, never read; the rollback', () => {
  it('a legacy row keeps working through its backfilled digest until the tick rotates it: revoked, plaintext nulled, the sharer told', async () => {
    const { customer, order } = await mkTrip();
    const legacySecret = `legacy-${Date.now()}-abcdefghijklmnop`;
    const legacy = await prisma.tripShareToken.create({ data: { tenantId: 'swift-default', orderId: order.id, createdByUserId: customer.id, token: legacySecret, tokenDigest: tripShareDigest(legacySecret), tokenPrefix: legacySecret.slice(0, 6), expiresAt: new Date(Date.now() + 3_600_000) } });
    expect(await svc.publicView(legacySecret)).not.toBeNull(); // dual-read: by digest
    const rot = await rotateLegacyTripShareTokens(prisma, new NotificationService(prisma, { to: () => ({ emit: () => {} }) } as never));
    expect(rot.rotated).toBeGreaterThanOrEqual(1);
    const after = await prisma.tripShareToken.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after.token).toBeNull(); expect(after.revokedAt).not.toBeNull(); expect(after.rotatedAt).not.toBeNull();
    expect(await svc.publicView(legacySecret)).toBeNull();
    expect(await prisma.notification.count({ where: { userId: customer.id, data: { path: ['kind'], equals: 'trip_share_rotated' } } })).toBe(1);
    expect((await rotateLegacyTripShareTokens(prisma, new NotificationService(prisma, { to: () => ({ emit: () => {} }) } as never))).remaining).toBe(0);
    expect(await prisma.notification.count({ where: { userId: customer.id, data: { path: ['kind'], equals: 'trip_share_rotated' } } })).toBe(1);
  });

  it('the rollback disables public lookup outright — a valid secret reads as nothing, and no plaintext comes back', async () => {
    const { customer, order } = await mkTrip();
    const share = await svc.mint(customer.id, order.id);
    process.env['TRIP_SHARE_PUBLIC_LOOKUP_KILL'] = '1';
    try {
      expect(await svc.publicView(share.token)).toBeNull();
    } finally {
      delete process.env['TRIP_SHARE_PUBLIC_LOOKUP_KILL'];
    }
    expect(await svc.publicView(share.token)).not.toBeNull();
    expect((await rowByDigest(share.token)).token).toBeNull();
  });
});
