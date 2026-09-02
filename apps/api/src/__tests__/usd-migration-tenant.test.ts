import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { NotificationService } from '../modules/notification/notification.service';
import { enableModeB, sweepModeB, rollbackModeB, modeBKey } from '../modules/billing/usd-migration';

// ---------------------------------------------------------------------------
// [M-15 · S0] The Mode B migration is one tenant's, its notices carry delivery
// proof, and nobody flips without it.
//
// Before: the default tenant's sunset selected and cleared EVERY tenant's
// grandfathered rates; the notice event was written before a send whose
// failure was swallowed; and a payer with missing notices was flipped anyway
// with a log line. Now every read and write is scoped to the tenant in Mode
// B, `deliveredAt` is stamped only after the send, undelivered notices are
// re-attempted, a payer past sunset without both proofs (the T−7 one a week
// old) stays pinned and the tenant's operators are paged, every freeze and
// flip writes an immutable snapshot, and rollback is a pointer back to it.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_BASE = 592_003_000_000 + Math.floor(Math.random() * 8_000_000);
let app: FastifyInstance;
let prisma: FastifyInstance['prisma'];
const userIds: string[] = [];
const subIds: string[] = [];
const vendorIds: string[] = [];
let otherTenantId: string;
let seq = 0;
const io = { to: () => ({ emit: () => {} }) } as never;

async function makeVendorSub(tenantId: string) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${PHONE_BASE + seq}`, firstName: 'Tenant', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, tenantId },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, tenantId, name: `Tenant Vendor ${seq}`, slug: `tenant-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${PHONE_BASE + 600_000 + seq}`,
      addressLine1: '15 Partition Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 20000, billingMethod: 'CASH',
      currentPeriodStart: new Date(Date.now() - 7 * DAY), currentPeriodEnd: new Date(), nextBillingDate: new Date(),
    },
  });
  subIds.push(sub.id);
  return { subId: sub.id, userId: user.id };
}
const rate = async (subId: string) => { const s = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } }); return s.customRate === null ? null : Number(s.customRate); };
const eventsOf = (subId: string) => prisma.billingEvent.findMany({ where: { subscriptionId: subId, idempotencyKey: { startsWith: 'usdmigB:' } }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  prisma = app.prisma;
  // A second operator. Inactive: the public tenant resolver requires exactly one active tenant.
  const other = await prisma.tenant.create({ data: { name: `Other Operator ${nanoid(4)}`, slug: `other-${nanoid(8).toLowerCase()}`, isActive: false } });
  otherTenantId = other.id;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdMigrationMode: null, usdSunsetAt: null } }).catch(() => {});
  await prisma.tenantBillingCurrency.deleteMany({ where: { tenantId: otherTenantId } }).catch(() => {});
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.delete({ where: { id: otherTenantId } }).catch(() => {});
  await app.close();
});

describe('[M-15] one tenant’s migration, with delivery proof and a hard flip gate', () => {
  it('the register’s red test: two tenants, Mode B only in the default one, a failed notification — the other tenant and the unnotified payer stay pinned', async () => {
    const told = await makeVendorSub('swift-default');
    const untold = await makeVendorSub('swift-default');
    const other = await makeVendorSub(otherTenantId);
    // The other operator's payer carries a genuine local override of its own —
    // exactly what a cross-tenant sweep would mistake for a grandfathered rate.
    await prisma.subscription.update({ where: { id: other.subId }, data: { customRate: 18000 } });
    // enableModeB freezes every unfrozen payer OF THE TENANT — in a shared run
    // that includes other suites' rows. Snapshot who was frozen before so the
    // finally thaws exactly what this test froze.
    const frozenBefore = new Set((await prisma.subscription.findMany({ where: { customRate: { not: null } }, select: { id: true } })).map((x) => x.id));
    const sunset = new Date(Date.now() + 31 * DAY);
    try {
      const enabled = await enableModeB(prisma, sunset, 'swift-default');
      expect(enabled).toMatchObject({ tenantId: 'swift-default' });
      expect(enabled.grandfathered).toBeGreaterThanOrEqual(2);
      expect(await rate(told.subId)).toBe(20000);
      expect(await rate(untold.subId)).toBe(20000);
      expect(await rate(other.subId)).toBe(18000); // the other operator is not in Mode B
      expect((await eventsOf(told.subId)).map((e) => e.idempotencyKey)).toEqual([modeBKey(told.subId, 'freeze')]); // the immutable assignment
      expect(await eventsOf(other.subId)).toEqual([]);
      expect(await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: otherTenantId } })).toBeNull();

      // T−20 and T−3: the untold payer's notifications fail; the told payer's go out.
      const failFor = new Set([untold.userId]);
      vi.spyOn(NotificationService.prototype, 'send').mockImplementation(async (input: { userId: string }) => {
        if (failFor.has(input.userId)) throw new Error('notification unavailable');
        return undefined as never;
      });
      const t20 = await sweepModeB(prisma, io, new Date(sunset.getTime() - 20 * DAY), { tenantIds: ['swift-default'] });
      expect(t20.undelivered).toBeGreaterThanOrEqual(1);
      const t3 = await sweepModeB(prisma, io, new Date(sunset.getTime() - 3 * DAY), { tenantIds: ['swift-default'] });
      expect(t3.undelivered).toBeGreaterThanOrEqual(1);
      const toldEvents = await eventsOf(told.subId);
      expect(toldEvents.filter((e) => e.type === 'REMINDER').map((e) => !!e.deliveredAt)).toEqual([true, true]);
      const untoldEvents = await eventsOf(untold.subId);
      expect(untoldEvents.filter((e) => e.type === 'REMINDER').map((e) => e.deliveredAt)).toEqual([null, null]); // the obligation exists, the proof does not
      expect(await eventsOf(other.subId)).toEqual([]);

      // Past sunset — but the told payer's T−7 was delivered only 3 days ago.
      const early = await sweepModeB(prisma, io, new Date(sunset.getTime() + 3_600_000), { tenantIds: ['swift-default'] });
      expect(early.flipped).toBe(0);
      expect(await rate(told.subId)).toBe(20000);
      // A week after the T−7 delivery: the told payer flips with a snapshot; the untold payer is HELD; the other tenant is untouched.
      const late = await sweepModeB(prisma, io, new Date(sunset.getTime() + 5 * DAY), { tenantIds: ['swift-default'] });
      expect(late.flipped).toBeGreaterThanOrEqual(1);
      expect(late.held).toBeGreaterThanOrEqual(1);
      expect(late.alerts).toBeGreaterThanOrEqual(1);
      expect(await rate(told.subId)).toBeNull();
      expect((await eventsOf(told.subId)).find((e) => e.idempotencyKey === modeBKey(told.subId, 'flip'))?.amount?.toString()).toBe('20000');
      expect(await rate(untold.subId)).toBe(20000); // pinned at the promised price
      expect(await rate(other.subId)).toBe(18000);
      expect(await eventsOf(other.subId)).toEqual([]);

      // The notices get through at last: still no flip until the T−7 proof is a week old.
      vi.restoreAllMocks();
      const delivered = await sweepModeB(prisma, io, new Date(sunset.getTime() + 5 * DAY), { tenantIds: ['swift-default'] });
      expect(delivered.delivered).toBeGreaterThanOrEqual(2);
      expect(await rate(untold.subId)).toBe(20000);
      const week = await sweepModeB(prisma, io, new Date(sunset.getTime() + 13 * DAY), { tenantIds: ['swift-default'] });
      expect(week.held).toBe(0);
      expect(await rate(untold.subId)).toBeNull();

      // Rollback: a pointer back to each payer's snapshot, this tenant only.
      const rolled = await rollbackModeB(prisma, 'swift-default');
      expect(rolled.restored).toBeGreaterThanOrEqual(2);
      expect(await rate(told.subId)).toBe(20000);
      expect(await rate(untold.subId)).toBe(20000);
      expect((await eventsOf(told.subId)).some((e) => e.idempotencyKey.startsWith(`usdmigB:${told.subId}:rollback:`))).toBe(true);
      expect(await rate(other.subId)).toBe(18000);
      expect((await prisma.tenantBillingCurrency.findUniqueOrThrow({ where: { tenantId: 'swift-default' } })).usdMigrationMode).toBeNull();
    } finally {
      vi.restoreAllMocks();
      await prisma.tenantBillingCurrency.update({ where: { tenantId: 'swift-default' }, data: { usdMigrationMode: null, usdSunsetAt: null } }).catch(() => {});
      const frozenNow = await prisma.subscription.findMany({ where: { customRate: { not: null } }, select: { id: true } });
      const thaw = frozenNow.map((x) => x.id).filter((id) => !frozenBefore.has(id));
      if (thaw.length) await prisma.subscription.updateMany({ where: { id: { in: thaw } }, data: { customRate: null } });
    }
  });
});
