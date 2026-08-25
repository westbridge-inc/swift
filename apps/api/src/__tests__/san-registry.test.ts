import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { ensureSan, releaseSan, resolveSan, backfillSans, sanDisplay } from '../modules/billing/san.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { luhnValid } from '../modules/billing/san';

// The SAN registry against the real DB [san spec 2.3-2.5]: assignment at
// birth, race-collapse, immutability via tombstones, the resolution pipeline,
// and the resumable backfill with its integrity assertion.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_005_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeVendorWithSub(over: { status?: string } = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'San', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `SAN Vendor ${seq}`, slug: `san-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '1 Luhn Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: (over.status ?? 'ACTIVE') as never, weeklyRate: 20000, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  subIds.push(sub.id);
  return { user, vendor, sub };
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.sanTombstone.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('SAN assignment', () => {
  it('assigns at birth through the real activation path (trial law included)', async () => {
    seq += 1;
    const user = await prisma.user.create({
      data: { phone: `+${phoneBase + seq}`, firstName: 'Birth', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
    });
    userIds.push(user.id);
    const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
    const vendor = await prisma.vendor.create({
      data: {
        ownerId: owner.id, name: `SAN Birth ${seq}`, slug: `sanb-${nanoid(8).toLowerCase()}`,
        vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
        addressLine1: '1 Luhn Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
      },
    });
    vendorIds.push(vendor.id);
    const sub = await new SubscriptionService(prisma).startTrialForVendor(vendor.id);
    subIds.push(sub.id);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.san).toMatch(/^[1-9][0-9]{9}$/);
    expect(luhnValid(row.san!)).toBe(true);
    expect(row.sanAssignedAt).toBeTruthy();
  });

  it('is idempotent and race-collapses: 12 concurrent calls yield one number', async () => {
    const { sub } = await makeVendorWithSub();
    const results = await Promise.all(Array.from({ length: 12 }, () => ensureSan(prisma, sub.id)));
    expect(new Set(results).size).toBe(1);
    expect(await ensureSan(prisma, sub.id)).toBe(results[0]);
  });

  it('distinct across subscriptions; sanDisplay heals and groups', async () => {
    const a = await makeVendorWithSub();
    const b = await makeVendorWithSub();
    const da = await sanDisplay(prisma, { id: a.sub.id, san: null }); // heal path
    const db_ = await sanDisplay(prisma, { id: b.sub.id, san: null });
    expect(da.san).not.toBe(db_.san);
    expect(da.sanFormatted).toBe(`${da.san.slice(0, 3)} ${da.san.slice(3, 6)} ${da.san.slice(6)}`);
  });
});

describe('resolution pipeline + tombstones', () => {
  it('resolves a live SAN; closed and tombstoned and unknown each carry their diagnosis', async () => {
    const live = await makeVendorWithSub();
    const san = await ensureSan(prisma, live.sub.id);
    const ok = await resolveSan(prisma, `${san.slice(0, 3)}-${san.slice(3, 6)}-${san.slice(6)}`); // grouped input normalizes
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.subscription.id).toBe(live.sub.id);

    expect((await resolveSan(prisma, '12345')).ok).toBe(false);
    expect((await resolveSan(prisma, '12345'))).toMatchObject({ code: 'SAN_MALFORMED' });
    const wrong = san.slice(0, 9) + String((Number(san[9]) + 1) % 10);
    expect(await resolveSan(prisma, wrong)).toMatchObject({ ok: false, code: 'SAN_CHECKSUM_FAILED' });

    const closed = await makeVendorWithSub({ status: 'CANCELLED' });
    const closedSan = await ensureSan(prisma, closed.sub.id);
    expect(await resolveSan(prisma, closedSan)).toMatchObject({ ok: false, code: 'ACCOUNT_CLOSED' });

    // Tombstone: released number never resolves to anyone and never returns.
    const erased = await makeVendorWithSub();
    const erasedSan = await ensureSan(prisma, erased.sub.id);
    await releaseSan(prisma, erased.sub.id, 'test-erasure');
    expect(await resolveSan(prisma, erasedSan)).toMatchObject({ ok: false, code: 'TOMBSTONED' });
    const again = await ensureSan(prisma, erased.sub.id); // a re-draw is a NEW number
    expect(again).not.toBe(erasedSan);
    expect((await prisma.sanTombstone.findUnique({ where: { san: erasedSan } }))?.reason).toBe('test-erasure');

    // A valid-Luhn number nobody holds → SAN_UNKNOWN (checksum can't save a
    // mis-key that beat the odds; resolution names it honestly).
    let unknown = '';
    for (;;) {
      const { generateSan } = await import('../modules/billing/san');
      unknown = generateSan();
      const held = await prisma.subscription.findUnique({ where: { san: unknown } });
      const dead = await prisma.sanTombstone.findUnique({ where: { san: unknown } });
      if (!held && !dead) break;
    }
    expect(await resolveSan(prisma, unknown)).toMatchObject({ ok: false, code: 'SAN_UNKNOWN' });
  });

  it('retires the live SAN and writes its global tombstone in one transaction', async () => {
    const owned = await makeVendorWithSub();
    const san = await ensureSan(prisma, owned.sub.id);
    const crashingPrisma = prisma.$extends({
      query: {
        subscription: {
          updateMany: async ({ args, query }) => {
            if ((args.data as { san?: string | null }).san === null) {
              throw new Error('TEST_CRASH_BEFORE_SAN_CLEAR');
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(releaseSan(crashingPrisma, owned.sub.id, 'atomicity-test'))
      .rejects.toThrow('TEST_CRASH_BEFORE_SAN_CLEAR');
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: owned.sub.id } })).san).toBe(san);
    expect(await prisma.sanTombstone.findUnique({ where: { san } })).toBeNull();

    await releaseSan(prisma, owned.sub.id, 'atomicity-test-retry');
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: owned.sub.id } })).san).toBeNull();
    expect(await prisma.sanTombstone.findUnique({ where: { san } })).toMatchObject({
      subscriptionId: owned.sub.id,
      reason: 'atomicity-test-retry',
    });
  });
});

describe('backfill', () => {
  it('assigns every bare subscription and passes the integrity assertion for them', async () => {
    const bare = await Promise.all([makeVendorWithSub(), makeVendorWithSub(), makeVendorWithSub()]);
    const res = await backfillSans(prisma);
    expect(res.assigned).toBeGreaterThanOrEqual(3);
    expect(res.luhnFailures).toBe(0);
    expect(res.distinct).toBe(res.total);
    const rows = await prisma.subscription.findMany({ where: { id: { in: bare.map((b) => b.sub.id) } }, select: { san: true } });
    for (const r of rows) expect(r.san).toMatch(/^[1-9][0-9]{9}$/);
  });
});
