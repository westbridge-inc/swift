import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { runBillingInvariants } from '../modules/billing/invariants';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { restoreBillingAccess } from '../modules/billing/billing-access';

// SUSPENSION-HEAL (AUD-L8b-003, FINAL §6b): the nightly detector finds a
// subscription that is SUSPENDED although it is paid through the future and
// heals it. A heal must give back everything the billing suspension took (the
// store's ACTIVE status and its order intake), not only the subscription row,
// or a paid store stays closed while the report says it was healed. Only a
// BILLING suspension is undone: an admin, safety or moderation hold survives.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const DAY = 86_400_000;
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_009_300_000 + Math.floor(Math.random() * 600_000);

/** A store billing suspended over a stale week, then paid through the future:
 *  exactly the state the wrongful-suspension detector exists to catch. */
async function wronglySuspendedStore(vendorOver: Record<string, unknown> = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Heal', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Heal Store ${seq}`, slug: `heal-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Heal St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING', isVerified: true,
      ...vendorOver,
    },
  });
  vendorIds.push(vendor.id);
  const end = new Date(Date.now() + 5 * DAY);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'SUSPENDED', suspendedAt: new Date(Date.now() - DAY),
      weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(end.getTime() - 7 * DAY), currentPeriodEnd: end, nextBillingDate: end,
    },
  });
  subIds.push(sub.id);
  // The suspension billing recorded for the week it missed.
  await prisma.billingEvent.create({
    data: { subscriptionId: sub.id, type: 'SUSPENDED', idempotencyKey: `suspended:${sub.id}:${end.toISOString().slice(0, 10)}`, note: 'test: recorded billing suspension' },
  });
  return { vendorId: vendor.id, subId: sub.id };
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  // [#1393] Clock evidence first (RESTRICT FKs).
  await cleanupBillingClocks(prisma, subIds);
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('SUSPENSION-HEAL — the wrongful-suspension heal reopens the store it closed', () => {
  it('a billing-suspended, paid-through store is ACTIVE and taking orders again after the heal', async () => {
    const s = await wronglySuspendedStore();
    const report = await runBillingInvariants(prisma);
    expect(report.wrongfulSuspensions).toContain(s.subId);
    expect(report.healedWithStoreStillHeld).not.toContain(s.subId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).status).toBe('ACTIVE');
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } });
    expect(v.status).toBe('ACTIVE');
    expect(v.suspensionSource).toBeNull();
    expect(v.acceptingOrders).toBe(true);
  });

  it('an ADMIN suspension survives the heal (only what billing took is given back)', async () => {
    const s = await wronglySuspendedStore({ suspensionSource: 'ADMIN' });
    await runBillingInvariants(prisma);
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } });
    expect(v.status).toBe('SUSPENDED');
    expect(v.suspensionSource).toBe('ADMIN');
    expect(v.acceptingOrders).toBe(false);
  });

  it.each(['ADMIN', null] as const)('a paid-through subscription is healed even when its store is held for another reason (source %s); the store stays held', async (source) => {
    // [#1516 review S3] The heal used to skip these silently: the subscription
    // stayed SUSPENDED although paid, and nothing was reported.
    const s = await wronglySuspendedStore({ suspensionSource: source });
    const report = await runBillingInvariants(prisma);
    expect(report.wrongfulSuspensions).toContain(s.subId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.subId } })).status).toBe('ACTIVE');
    expect(await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } }))
      .toMatchObject({ status: 'SUSPENDED', suspensionSource: source, acceptingOrders: false });
    // The page names it: the fee is healed, the store is still closed and an operator decides it.
    expect(report.healedWithStoreStillHeld).toContain(s.subId);
    // The heal's record says what happened, not that the store was reopened.
    const heal = await prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: s.subId, type: 'REINSTATED' } });
    expect(heal.note).toContain('store left held');
    expect(heal.note).not.toContain('store access restored');
  });

  it('reports the authoritative ADMIN hold when the store changes after the subscription snapshot', async () => {
    const s = await wronglySuspendedStore({ status: 'ACTIVE', suspensionSource: null, acceptingOrders: true });
    let interleaved = false;
    const racing = new Proxy(prisma, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async (tx) => work(new Proxy(tx, {
          get(transaction, field) {
            if (field !== 'subscription') return Reflect.get(transaction, field);
            return new Proxy(transaction.subscription, {
              get(delegate, method) {
                if (method !== 'findUniqueOrThrow') return Reflect.get(delegate, method);
                return async (args: Prisma.SubscriptionFindUniqueOrThrowArgs) => {
                  const snapshot = await delegate.findUniqueOrThrow(args);
                  if (!interleaved && args.where.id === s.subId && args.include?.vendor === true) {
                    interleaved = true;
                    await prisma.vendor.update({ where: { id: s.vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'ADMIN', acceptingOrders: false } });
                  }
                  return snapshot;
                };
              },
            });
          },
        })));
      },
    });
    const report = await runBillingInvariants(racing);
    expect(interleaved).toBe(true);
    expect(report.wrongfulSuspensions).toContain(s.subId);
    expect(report.healedWithStoreStillHeld).toContain(s.subId);
    expect(await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } }))
      .toMatchObject({ status: 'SUSPENDED', suspensionSource: 'ADMIN', acceptingOrders: false });
    const event = await prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: s.subId, type: 'REINSTATED' } });
    expect(event.note).toContain('store left held (SUSPENDED, source ADMIN)');
    expect(event.note).not.toContain('store access restored');
  });

  it('a store whose documents lapsed comes back ACTIVE but NOT taking orders', async () => {
    const s = await wronglySuspendedStore({ isVerified: false });
    await runBillingInvariants(prisma);
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } });
    expect(v.acceptingOrders).toBe(false);
  });

  it('[Fable #1481 S4-2] a store an admin already reinstated (ACTIVE, stale BILLING source) keeps the intake its owner chose', async () => {
    const s = await wronglySuspendedStore({ status: 'ACTIVE', acceptingOrders: false, suspensionSource: 'BILLING' });
    const report = await runBillingInvariants(prisma);
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } });
    expect(v.status).toBe('ACTIVE');
    expect(v.acceptingOrders).toBe(false);
    // An open store is not a held one: nothing for an operator to decide.
    expect(report.wrongfulSuspensions).toContain(s.subId);
    expect(report.healedWithStoreStillHeld).not.toContain(s.subId);
  });

  it('[Fable #1481 S4-1] a suspension with no source (an owner closing their account) is never lifted as a billing one', async () => {
    const s = await wronglySuspendedStore({ suspensionSource: null });
    await runBillingInvariants(prisma);
    expect(await prisma.$transaction((tx) => restoreBillingAccess(tx, s.vendorId))).toBe(false);
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } });
    expect(v.status).toBe('SUSPENDED');
    expect(v.acceptingOrders).toBe(false);
  });

  it('running the heal twice changes nothing more and records one heal', async () => {
    const s = await wronglySuspendedStore();
    await runBillingInvariants(prisma);
    await runBillingInvariants(prisma);
    const heals = await prisma.billingEvent.count({ where: { subscriptionId: s.subId, type: 'REINSTATED' } });
    expect(heals).toBe(1);
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } });
    expect(v.status).toBe('ACTIVE');
    expect(v.acceptingOrders).toBe(true);
  });
});
