import { currentTaxiSplitDocuments } from './helpers/current-mover-documents';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { wordFreeTag } from './helpers/fixture-ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { runWithTenant } from '../plugins/tenant-context';
import { platformStats } from '../modules/admin/platform-stats';
import { lockMoverFeeAuthority, readFeeCollectionAuthorities, readFeeCollectionAuthority } from '../modules/subscription/mover-fee-authority';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [PERF row 561] The admin console's home was its slowest page. For the
// "billed this week" figure it asked readFeeCollectionAuthority once per
// ACTIVE subscription, each mover's in a transaction of its own: measured
// locally at 0.46 s (210 subscriptions) and 0.82 s (500), on every 30 s
// refresh, growing with every partner. readFeeCollectionAuthorities answers
// the whole list in a fixed number of reads, with the SAME answer per
// subscription. A payer whose answer can depend on money history goes
// through readFeeCollectionAuthority unchanged.
// ---------------------------------------------------------------------------

const TENANT = 'swift-default';
const DAY = 86_400_000;
const run = nanoid(7);
let app: FastifyInstance;
const users: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-admin-overview-authorities');
// One clock for every fixture: two trials only count as twins when their dates match to the millisecond.
const START = new Date(Date.now() - DAY);
const END = new Date(START.getTime() + 7 * DAY);
const week = (status: 'ACTIVE' | 'TRIAL' = 'ACTIVE') => ({ status, currencyCode: 'GYD', currentPeriodStart: START, currentPeriodEnd: END, nextBillingDate: END,
  isTrialActive: status === 'TRIAL', trialEndDate: status === 'TRIAL' ? END : null });
const scope = (tenantId: string) => ({ OR: [
  { vendor: { tenantId }, riderId: null, driverId: null },
  { rider: { user: { tenantId } }, vendorId: null, driverId: null },
  { driver: { user: { tenantId } }, vendorId: null, riderId: null },
] });

async function person(roles: string[]) {
  return sys(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `+59200561${Date.now()}${users.length}`, firstName: 'Fee', lastName: 'Fixture', tenantId: TENANT, countryCode: 'GY',
      roles: roles as never[], activeRole: roles[0] as never, isPhoneVerified: true, selfieCapturedAt: new Date(),
    } });
    users.push(user.id);
    return user.id;
  });
}
async function vendorSub(status: 'ACTIVE' | 'TRIAL' = 'ACTIVE') {
  const userId = await person(['VENDOR_OWNER', 'CUSTOMER']);
  return sys(async () => {
    const owner = await app.prisma.vendorOwner.create({ data: { userId } });
    const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: `Fee Store ${wordFreeTag(8)}`, slug: `fee-${run.toLowerCase()}-${users.length}`, vendorType: 'RESTAURANT',
      phone: '+5920000561', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' } });
    return (await app.prisma.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', weeklyRate: 6000, ...week(status) } })).id;
  });
}
async function riderOnly() {
  const userId = await person(['MOVER', 'CUSTOMER']);
  return sys(async () => ({ userId, riderId: (await app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } })).id }));
}
async function addDriver(userId: string) {
  return sys(async () => {
    const driver = await app.prisma.driver.create({ data: { userId, vehicleType: 'CAR', documentsVerified: true,
      vehicleMake: 'Test', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `HFEE-${run}-${users.length}`, driverLicenseUrl: 'storage://test/dl', vehicleInsuranceUrl: 'storage://test/insurance' } });
    await app.prisma.verificationDocument.create({ data: { userId, role: 'MOVER', docType: 'vehicle_insurance', fileUrl: 'storage://test/insurance', status: 'APPROVED', coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true, consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    await currentTaxiSplitDocuments(app.prisma, userId);
    return driver.id;
  });
}
const riderSub = (riderId: string, extra: Record<string, unknown> = {}) => sys(async () => (await app.prisma.subscription.create({ data: { riderId, type: 'DELIVERY_RIDER', weeklyRate: 6000, ...week(), ...extra } })).id);
const driverSub = (driverId: string, extra: Record<string, unknown> = {}) => sys(async () => (await app.prisma.subscription.create({ data: { driverId, type: 'TAXI_DRIVER', weeklyRate: 9000, ...week(), ...extra } })).id);
const persist = (userId: string) => sys(() => app.prisma.$transaction((tx) => lockMoverFeeAuthority(tx, { userId, tenantId: TENANT })));
const paid = (subscriptionId: string) => sys(async () => {
  const start = new Date(Date.now() - DAY);
  await app.prisma.subscriptionPayment.create({ data: { subscriptionId, amount: 6000, paymentMethod: 'CASH', status: 'CAPTURED', paidAt: start, periodStart: start, periodEnd: new Date(start.getTime() + 7 * DAY) } });
});

/** Every Prisma call made through `db` (models, raw, and inside its transactions). */
function counted(db: PrismaClient): { db: PrismaClient; calls: () => number } {
  let n = 0;
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver);
      if (key === '$transaction') {
        return (arg: unknown, ...rest: unknown[]) => (typeof arg === 'function'
          ? (value as (...a: unknown[]) => unknown).call(obj, (tx: object) => (arg as (t: object) => unknown)(wrap(tx)), ...rest)
          : (value as (...a: unknown[]) => unknown).call(obj, arg, ...rest));
      }
      if (typeof key === 'string' && (key.startsWith('$queryRaw') || key.startsWith('$executeRaw'))) {
        return (...a: unknown[]) => { n += 1; return (value as (...b: unknown[]) => unknown).apply(obj, a); };
      }
      if (typeof key === 'string' && !key.startsWith('$') && !key.startsWith('_') && value && typeof value === 'object') {
        return new Proxy(value as object, { get(model, op, r) {
          const fn = Reflect.get(model, op, r);
          return typeof fn === 'function' ? (...a: unknown[]) => { n += 1; return (fn as (...b: unknown[]) => unknown).apply(model, a); } : fn;
        } });
      }
      return value;
    },
  });
  return { db: wrap(db), calls: () => n };
}

const fixtures: Record<string, string> = {};

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  fixtures['store'] = await vendorSub();
  fixtures['store on trial'] = await vendorSub('TRIAL');
  const lone = await riderOnly();
  fixtures['lone rider, no decision yet'] = await riderSub(lone.riderId);
  const wrongType = await riderOnly();
  fixtures['rider source of a store type'] = await riderSub(wrongType.riderId, { type: 'RESTAURANT' });
  const decided = await riderOnly();
  fixtures['rider with a persisted decision'] = await riderSub(decided.riderId);
  await persist(decided.userId);
  const added = await riderOnly();
  fixtures['decision, then a new driver source (rider side)'] = await riderSub(added.riderId);
  await persist(added.userId);
  fixtures['decision, then a new driver source (driver side)'] = await driverSub(await addDriver(added.userId));
  const twins = await riderOnly();
  const twinsDriver = await addDriver(twins.userId);
  fixtures['two empty trials, decided ACTIVE (rider alias)'] = await riderSub(twins.riderId, week('TRIAL'));
  fixtures['two empty trials, decided ACTIVE (driver canonical)'] = await driverSub(twinsDriver, week('TRIAL'));
  await persist(twins.userId);
  const later = await riderOnly();
  const laterDriver = await addDriver(later.userId);
  fixtures['decided ACTIVE, then money on the alias (rider)'] = await riderSub(later.riderId, week('TRIAL'));
  fixtures['decided ACTIVE, then money on the alias (driver)'] = await driverSub(laterDriver, week('TRIAL'));
  await persist(later.userId);
  await paid(fixtures['decided ACTIVE, then money on the alias (rider)']!);
  const held = await riderOnly();
  const heldDriver = await addDriver(held.userId);
  fixtures['two paid sources, held for review (rider)'] = await riderSub(held.riderId);
  fixtures['two paid sources, held for review (driver)'] = await driverSub(heldDriver);
  await paid(fixtures['two paid sources, held for review (rider)']!);
  await persist(held.userId);
  const undecided = await riderOnly();
  const undecidedDriver = await addDriver(undecided.userId);
  fixtures['two sources, no decision yet (rider)'] = await riderSub(undecided.riderId);
  fixtures['two sources, no decision yet (driver)'] = await driverSub(undecidedDriver);
  fixtures['no such subscription'] = `missing-${run}`;
}, 120_000);

afterAll(async () => {
  await sys(async () => {
    // This suite's people (and any a crashed earlier run left behind): the phone prefix is the suite's own.
    const mine = (await app.prisma.user.findMany({ where: { OR: [{ id: { in: users } }, { phone: { startsWith: '+59200561' } }] }, select: { id: true } })).map((u) => u.id);
    const storeSubs = (await app.prisma.subscription.findMany({ where: { vendor: { owner: { userId: { in: mine } } } }, select: { id: true } })).map((s) => s.id);
    const moverSubs = (await app.prisma.subscription.findMany({ where: { OR: [{ rider: { userId: { in: mine } } }, { driver: { userId: { in: mine } } }] }, select: { id: true } })).map((s) => s.id);
    await cleanupPayerBillingClocks(app.prisma, mine);
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: [...storeSubs, ...moverSubs] } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: storeSubs } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: mine } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: mine } } });
    // A mover's fee authority and its sources go with the payer (the database refuses them alone).
    await app.prisma.user.deleteMany({ where: { id: { in: mine } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: moverSubs } } });
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: mine } }, { entityId: { in: mine } }] }, 'test-admin-overview-authorities-cleanup');
  });
  await app.close();
}, 120_000);

describe('readFeeCollectionAuthorities', () => {
  it('gives every subscription the same answer as readFeeCollectionAuthority', async () => {
    const ids = Object.values(fixtures);
    const batch = await runWithTenant(TENANT, () => readFeeCollectionAuthorities(app.prisma, ids));
    for (const [name, id] of Object.entries(fixtures)) {
      const one = await runWithTenant(TENANT, () => readFeeCollectionAuthority(app.prisma, id));
      expect({ name, ...batch.get(id) }).toEqual({ name, ...one });
    }
    expect(batch.size).toBe(ids.length);
  });

  it('the fixtures cover every way an answer is reached (the comparison is not looking at one shape)', async () => {
    const batch = await runWithTenant(TENANT, () => readFeeCollectionAuthorities(app.prisma, Object.values(fixtures)));
    const at = (name: string) => batch.get(fixtures[name]!)!;
    expect(at('store')).toEqual({ allowed: true, canonical: true, mover: null });
    expect(at('lone rider, no decision yet')).toMatchObject({ allowed: true, canonical: true, mover: { state: 'ACTIVE', revision: 0 } });
    expect(at('rider source of a store type')).toEqual({ allowed: false, canonical: false, mover: null });
    expect(at('rider with a persisted decision')).toMatchObject({ allowed: true, mover: { state: 'ACTIVE', revision: 1 } });
    expect(at('decision, then a new driver source (rider side)')).toMatchObject({ allowed: false, canonical: true, mover: { state: 'FINANCE_HOLD', holdReason: 'UNREGISTERED_MOVER_SOURCE' } });
    expect(at('two empty trials, decided ACTIVE (driver canonical)')).toMatchObject({ allowed: true, canonical: true });
    expect(at('two empty trials, decided ACTIVE (rider alias)')).toMatchObject({ allowed: false, canonical: false });
    expect(at('two paid sources, held for review (driver)')).toMatchObject({ allowed: false, mover: { state: 'FINANCE_HOLD' } });
    expect(at('two sources, no decision yet (driver)').mover?.state).toBe('FINANCE_HOLD');
    expect(at('no such subscription')).toEqual({ allowed: false, canonical: false, mover: null });
    expect(at('decided ACTIVE, then money on the alias (driver)')).toMatchObject({ allowed: false, canonical: true, mover: { state: 'FINANCE_HOLD', holdReason: 'HISTORICAL_SOURCE_MONEY' } });
  });

  it('decides the common shapes without a per-subscription read (only money-history shapes take the slow path)', async () => {
    const base = [fixtures['store']!, fixtures['lone rider, no decision yet']!];
    const fast = [...base, ...[
      'store on trial', 'rider source of a store type', 'rider with a persisted decision',
      'decision, then a new driver source (rider side)', 'decision, then a new driver source (driver side)',
      'two paid sources, held for review (rider)', 'two paid sources, held for review (driver)', 'no such subscription',
    ].map((name) => fixtures[name]!)];
    const c1 = counted(app.prisma);
    await runWithTenant(TENANT, () => readFeeCollectionAuthorities(c1.db, base));
    const c2 = counted(app.prisma);
    await runWithTenant(TENANT, () => readFeeCollectionAuthorities(c2.db, fast));
    expect(c2.calls()).toBe(c1.calls());
    const c3 = counted(app.prisma);
    await runWithTenant(TENANT, () => readFeeCollectionAuthorities(c3.db, [...base, fixtures['two sources, no decision yet (rider)']!]));
    expect(c3.calls()).toBeGreaterThan(c1.calls()); // the slow path is really taken (and counted) for an undecided pair
  });

  it('reads a list in a fixed number of calls, however many stores and riders it holds', async () => {
    const small = [await vendorSub(), await riderSub((await riderOnly()).riderId)];
    const many: string[] = [];
    for (let i = 0; i < 12; i += 1) many.push(await vendorSub(), await riderSub((await riderOnly()).riderId));
    const c1 = counted(app.prisma);
    await runWithTenant(TENANT, () => readFeeCollectionAuthorities(c1.db, small));
    const c2 = counted(app.prisma);
    await runWithTenant(TENANT, () => readFeeCollectionAuthorities(c2.db, many));
    expect(c2.calls()).toBe(c1.calls());
    expect(c2.calls()).toBeLessThanOrEqual(6);
  }, 120_000);
});

describe('the admin home (platformStats)', () => {
  it('does not ask once per subscription: the same number of calls for 2 or 26 subscriptions', async () => {
    const scoped = (ids: string[]) => ({ id: { in: ids } });
    const two = [fixtures['store']!, fixtures['lone rider, no decision yet']!];
    const extra: string[] = [];
    for (let i = 0; i < 12; i += 1) extra.push(await vendorSub(), await riderSub((await riderOnly()).riderId));
    const c1 = counted(app.prisma);
    await runWithTenant(TENANT, () => platformStats(c1.db, { tenantId: TENANT, today: new Date(), subscriptionScope: scoped(two) }));
    const c2 = counted(app.prisma);
    const stats = await runWithTenant(TENANT, () => platformStats(c2.db, { tenantId: TENANT, today: new Date(), subscriptionScope: scoped([...two, ...extra]) }));
    expect(c2.calls()).toBe(c1.calls());
    expect(stats.activeSubscriptions).toHaveLength(26);
  }, 120_000);

  it('counts what the biller would: allowed subscriptions only, movers by their decided fee type', async () => {
    const ids = Object.values(fixtures);
    // The route's own tenant scope (admin.routes subscriptionTenantScope), narrowed to this file's fixtures. The expected
    // set below is read WITHOUT the tenant scope, so a scope that dropped any fixture would fail this test too.
    const stats = await runWithTenant(TENANT, () => platformStats(app.prisma, { tenantId: TENANT, today: new Date(), subscriptionScope: { ...scope(TENANT), id: { in: ids } } }));
    const expected: Array<{ id: string; type: string }> = [];
    const active = await sys(() => app.prisma.subscription.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true, type: true } }));
    for (const sub of active) {
      const one = await runWithTenant(TENANT, () => readFeeCollectionAuthority(app.prisma, sub.id));
      if (one.allowed) expected.push({ id: sub.id, type: one.mover?.feeType ?? sub.type });
    }
    const got = stats.activeSubscriptions.map((s) => ({ id: s.id, type: s.type })).sort((a, b) => a.id.localeCompare(b.id));
    expect(got).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
    expect(got.length).toBeGreaterThanOrEqual(3);
  });
});
