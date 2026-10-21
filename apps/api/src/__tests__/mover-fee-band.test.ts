import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { UserRole, VehicleType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { VEHICLE_CLASSES, VEHICLE_TYPES_IN_ORDER, feeBandFor, isPassengerVehicle, isVehicleOffered } from '../config/vehicle-classes';
import { partnerRateFor, type SubscriptionTiers } from '../modules/country/country-config.service';
import { PartnerService } from '../modules/partner/partner.service';
import { lockMoverFeeAuthority, resolveMoverFeeAuthority } from '../modules/subscription/mover-fee-authority';
import { cleanupBillingClocks, cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
// [Owner ruling 11 Oct 2026 — H-PLATE] A taxi (car / wagon car) plate is H-series where it is typed; fixture plates follow it. Buses keep B-series.

// ---------------------------------------------------------------------------
// The mover weekly fee follows the ROLE first, then the VEHICLE — never the
// service performed, and never the rate a mover happened to sign up on. A taxi
// Driver pays the market's taxi rate whatever the vehicle (where the market
// sets one); a delivery/courier Rider pays the band of the vehicle registered:
//
//   STANDARD  bicycle, motorbike, car, wagon car
//   HEAVY     bus (9/15), canter (short/long), box truck (short/long)
//
// The point of this file is that the number a mover is CHARGED matches the
// number the public site QUOTES. A price that is only correct on the marketing
// page is not a price.
// ---------------------------------------------------------------------------

const STANDARD_VEHICLES: VehicleType[] = ['BICYCLE', 'MOTORCYCLE', 'CAR', 'WAGON_CAR'];
const HEAVY_VEHICLES: VehicleType[] = [
  'BUS_9', 'BUS_15', 'CANTER_SHORT', 'CANTER_LONG', 'BOX_TRUCK_SHORT', 'BOX_TRUCK_LONG',
];

describe('mover fee band — classification', () => {
  it('every vehicle in the fleet has a band; the two lists together ARE the fleet', () => {
    // If a VehicleType is added without a band this fails, rather than quietly
    // billing the new vehicle at the standard rate.
    const all = Object.keys(VEHICLE_CLASSES).sort();
    expect([...STANDARD_VEHICLES, ...HEAVY_VEHICLES].sort()).toEqual(all);
    for (const v of all) expect(VEHICLE_CLASSES[v as VehicleType].feeBand).toBeDefined();
  });

  it('the everyday fleet is STANDARD and the commercial fleet is HEAVY', () => {
    for (const v of STANDARD_VEHICLES) expect(feeBandFor(v)).toBe('STANDARD');
    for (const v of HEAVY_VEHICLES) expect(feeBandFor(v)).toBe('HEAVY');
  });
});

describe('mover fee band — the rate resolver', () => {
  // A market that prices by band alone: no taxi rate, so the band decides for
  // Riders and Drivers alike.
  const tiers: SubscriptionTiers = { mover: 10000, moverHeavy: 12000, smallVendor: 20000, largeVendor: 30000 };
  const rateOf = (t: SubscriptionTiers, kind: 'RIDER' | 'DRIVER', vehicleType: VehicleType) =>
    partnerRateFor(t, { kind, vehicleType }).rate;

  it('resolves each vehicle to its band rate', () => {
    for (const kind of ['RIDER', 'DRIVER'] as const) {
      for (const v of STANDARD_VEHICLES) expect(rateOf(tiers, kind, v)).toBe(10000);
      for (const v of HEAVY_VEHICLES) expect(rateOf(tiers, kind, v)).toBe(12000);
    }
  });

  it('a market with no heavy rate falls back to the standard rate — never 0, never undefined', () => {
    const noHeavy: SubscriptionTiers = { mover: 10000, smallVendor: 20000, largeVendor: 30000 };
    for (const v of HEAVY_VEHICLES) {
      expect(rateOf(noHeavy, 'RIDER', v)).toBe(10000);
      expect(Number.isFinite(rateOf(noHeavy, 'DRIVER', v))).toBe(true);
    }
  });

  it('a market with a taxi rate prices every Driver by role, car or bus; Riders stay on their band', () => {
    const taxi: SubscriptionTiers = { ...tiers, taxiDriver: 11000 };
    for (const v of [...STANDARD_VEHICLES, ...HEAVY_VEHICLES]) {
      expect(partnerRateFor(taxi, { kind: 'DRIVER', vehicleType: v })).toEqual({ rate: 11000, tier: 'taxi' });
    }
    for (const v of STANDARD_VEHICLES) expect(rateOf(taxi, 'RIDER', v)).toBe(10000);
    for (const v of HEAVY_VEHICLES) expect(rateOf(taxi, 'RIDER', v)).toBe(12000);
  });
});

describe('vendor rate — services and catalogue tiers; every store pays its own tier', () => {
  // [Owner, 13 Oct 2026 — decision 49] No multi-store discount: "they pay per
  // store and each store has to have its own account and pay per size of
  // catalogue." This card still carries the keys of the rule the owner removed,
  // as a database not yet re-seeded does: they must change nothing.
  const tiers: SubscriptionTiers = {
    mover: 10000, moverHeavy: 12000, serviceVendor: 12000,
    smallVendor: 20000, largeVendor: 30000, departmentVendor: 50000,
    largeCatalogueThreshold: 1000, departmentCatalogueThreshold: 10000,
    franchiseMinLocations: 5, franchiseDiscountPct: 50,
  };
  const vendor = (isService: boolean, activeListings: number) =>
    partnerRateFor(tiers, { kind: 'VENDOR', isService, activeListings });
  const shop = (activeListings: number) => vendor(false, activeListings);

  it('a service carries no catalogue and pays the service rate', () => {
    expect(vendor(true, 0)).toEqual({ rate: 12000, tier: 'service' });
  });

  it('catalogue tiers step at their thresholds, and the threshold itself qualifies', () => {
    expect(shop(0).rate).toBe(20000);
    expect(shop(999).rate).toBe(20000);
    expect(shop(1000)).toEqual({ rate: 30000, tier: 'large' });
    expect(shop(9999).rate).toBe(30000);
    expect(shop(10000)).toEqual({ rate: 50000, tier: 'department' });
  });

  it('every store pays the full rate of its own tier — the leftover keys of the removed rule discount nothing', () => {
    expect(shop(50)).toEqual({ rate: 20000, tier: 'small' });
    expect(shop(5000)).toEqual({ rate: 30000, tier: 'large' });
    expect(shop(20000)).toEqual({ rate: 50000, tier: 'department' });
    expect(vendor(true, 0)).toEqual({ rate: 12000, tier: 'service' });
    // Five stores of one owner pay five full rates.
    expect(shop(50).rate * 5).toBe(100000);
  });

  it('a market that has priced none of the new tiers behaves exactly as before', () => {
    const legacy: SubscriptionTiers = { mover: 10000, smallVendor: 20000, largeVendor: 30000 };
    expect(partnerRateFor(legacy, { kind: 'VENDOR', isService: true, activeListings: 0 }).rate).toBe(20000);
    expect(partnerRateFor(legacy, { kind: 'VENDOR', isService: false, activeListings: 50000 })).toEqual({ rate: 30000, tier: 'large' });
  });
});

describe('mover fee band — what a mover is actually charged', () => {
  let app: FastifyInstance;
  let billing: BillingService;
  let subscriptions: SubscriptionService;
  const createdUserIds: string[] = [];
  let seq = 0;
  const fixtureStamp = Date.now().toString().slice(-6);

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(socketPlugin);
    await app.ready();

    const notifications = new NotificationService(app.prisma, app.io);
    billing = new BillingService(app.prisma, notifications, getPaymentProvider());
    subscriptions = new SubscriptionService(app.prisma);
  });

  afterAll(async () => {
    await cleanupPayerBillingClocks(app.prisma, createdUserIds);
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('the SEEDED Guyana rate card matches the owner rate card exactly', async () => {
    // Read from the CountryConfig row the public pricing endpoint serves, so a
    // stale database fails loudly instead of testing a number nobody ships.
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const seeded = gy.subscriptionTiers as unknown as SubscriptionTiers;
    expect(seeded, 'GY rate card — re-run the seed if this fails').toMatchObject({
      mover: 6000, moverHeavy: 9000, taxiDriver: 8000, serviceVendor: 8000,
      smallVendor: 15000, largeVendor: 20000, departmentVendor: 60000,
      largeCatalogueThreshold: 1000, departmentCatalogueThreshold: 10000,
    });
    // No multi-store rule (owner, 13 Oct 2026): the seed writes none.
    expect(Object.keys(seeded).filter((key) => /franchise/i.test(key))).toEqual([]);
  });

  async function makeMoverUser() {
    seq += 1;
    const user = await app.prisma.user.create({
      data: {
        phone: `+59200077${fixtureStamp}${String(seq).padStart(2, '0')}`,
        firstName: 'Band',
        lastName: `Mover${seq}`,
        roles: ['MOVER', 'CUSTOMER'] as UserRole[],
        activeRole: 'MOVER' as UserRole,
        countryCode: 'GY',
        isPhoneVerified: true,
      },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function makeDriver(userId: string, vehicleType: VehicleType) {
    seq += 1;
    return app.prisma.driver.create({
      data: {
        userId,
        vehicleType,
        vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleYear: 2020,
        vehicleColor: 'White', licensePlate: `BAND-${seq}`,
        driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
        documentsVerified: true,
      },
    });
  }

  async function makeRider(userId: string, vehicleType: VehicleType, riderType: 'DELIVERY' | 'COURIER' = 'DELIVERY') {
    return app.prisma.rider.create({ data: { userId, riderType, vehicleType } });
  }

  it('a motorbike delivery rider signs up on 6,000', async () => {
    const rider = await makeRider(await makeMoverUser(), 'MOTORCYCLE');
    const sub = await subscriptions.startTrialForRider(rider.id);
    expect(Number(sub.weeklyRate)).toBe(6000);
  });

  it('a canter courier signs up on 9,000 — heavy delivery: the same service, the bigger vehicle', async () => {
    const rider = await makeRider(await makeMoverUser(), 'CANTER_LONG', 'COURIER');
    const sub = await subscriptions.startTrialForRider(rider.id);
    expect(Number(sub.weeklyRate)).toBe(9000);
  });

  it('every taxi driver signs up on 8,000 — a car or a 15-seater bus', async () => {
    const car = await makeDriver(await makeMoverUser(), 'CAR');
    expect(Number((await subscriptions.startTrialForDriver(car.id)).weeklyRate)).toBe(8000);

    const bus = await makeDriver(await makeMoverUser(), 'BUS_15');
    expect(Number((await subscriptions.startTrialForDriver(bus.id)).weeklyRate)).toBe(8000);
  });

  it.each(['taxi-first', 'delivery-first'] as const)('a driver who also delivers has one taxi subscription, in %s activation order', async (order) => {
    const userId = await makeMoverUser();
    const partners = new PartnerService(app.prisma);
    const driver = await partners.becomePartner(userId, { role: 'MOVER', vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Test', year: 2020, color: 'White', licensePlate: `HDUAL-${seq}` } });
    const rider = await partners.becomePartner(userId, { role: 'MOVER', vehicleType: 'MOTORCYCLE' });
    expect(driver.kind).toBe('DRIVER');
    expect(rider.kind).toBe('RIDER');
    await app.prisma.driver.update({ where: { id: driver.id }, data: { documentsVerified: true } });
    await app.prisma.rider.update({ where: { id: rider.id }, data: { documentsVerified: true } });
    const first = order === 'taxi-first'
      ? await subscriptions.startTrialForDriver(driver.id)
      : await subscriptions.startTrialForRider(rider.id);
    const second = order === 'taxi-first'
      ? await subscriptions.startTrialForRider(rider.id)
      : await subscriptions.startTrialForDriver(driver.id);
    const owned = await app.prisma.subscription.findMany({ where: { OR: [{ driverId: driver.id }, { riderId: rider.id }] } });
    const due = new Date(Date.now() - 60_000);
    for (const sub of owned) {
      // [#1393] Aging input: the trial is over and the week is due. The shared
      // clock is born at the trial's due date, so compressing time re-anchors
      // this test-owned clock (no money, hold or notice exists before the first fee).
      await cleanupBillingClocks(app.prisma, [sub.id]);
      await app.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', isTrialActive: false, currentPeriodStart: new Date(due.getTime() - 7 * 86_400_000), currentPeriodEnd: due, nextBillingDate: due } });
      await app.prisma.prepaidBalance.upsert({ where: { subscriptionId: sub.id }, create: { subscriptionId: sub.id, balance: 20000, currencyCode: 'GYD' }, update: { balance: 20000 } });
      const ready = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } } });
      expect(await billing.billSubscription(ready)).toBe('succeeded');
    }
    const charges = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: { in: owned.map((s) => s.id) }, status: 'CAPTURED' } });
    const total = charges.reduce((sum, p) => sum + Number(p.amount), 0);
    // Aggregate diagnostic only: no account identifiers, session or contact data.
    console.info('TAXI_DUAL_BILLING', { order, subscriptions: owned.length, chargeCount: charges.length, total });
    expect(owned).toHaveLength(1);
    expect(charges).toHaveLength(1);
    expect(total).toBe(8000);
    expect(first.id).toBe(second.id);
    expect(owned[0]?.type).toBe(order === 'taxi-first' ? 'TAXI_DRIVER' : 'DELIVERY_RIDER');
    expect(await resolveMoverFeeAuthority(app.prisma, { userId, tenantId: 'swift-default' })).toMatchObject({ canonicalSubscriptionId: first.id, feeType: 'TAXI_DRIVER', state: 'ACTIVE' });
    expect(await app.prisma.trialGrant.count({ where: { accountId: userId } })).toBe(1);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: first.id } })).balance)).toBe(12000);
    expect(Number(owned[0]?.weeklyRate)).toBe(8000);
    expect(await subscriptions.priceForActivation({ driverId: driver.id })).toBeNull();
    expect(await subscriptions.priceForActivation({ riderId: rider.id })).toBeNull();
  });

  it('concurrent Driver and Rider activation shares one trial, source and future taxi fee', async () => {
    const userId = await makeMoverUser();
    const driver = await makeDriver(userId, 'CAR');
    const rider = await makeRider(userId, 'MOTORCYCLE');
    const results = await Promise.all([
      subscriptions.startTrialForDriver(driver.id), subscriptions.startTrialForRider(rider.id),
      subscriptions.startTrialForDriver(driver.id), subscriptions.startTrialForRider(rider.id),
    ]);
    expect(new Set(results.map((s) => s.id)).size).toBe(1);
    expect(await app.prisma.subscription.count({ where: { OR: [{ riderId: rider.id }, { driverId: driver.id }] } })).toBe(1);
    expect(await app.prisma.trialGrant.count({ where: { accountId: userId } })).toBe(1);
    const authority = await resolveMoverFeeAuthority(app.prisma, { userId, tenantId: 'swift-default' });
    expect(authority).toMatchObject({ canonicalSubscriptionId: results[0]!.id, feeType: 'TAXI_DRIVER', state: 'ACTIVE' });
    const source = await app.prisma.subscription.findUniqueOrThrow({ where: { id: authority!.canonicalSubscriptionId } });
    expect(Number(source.weeklyRate)).toBe(8000);
    expect(new Set(results.map((s) => s.trialEndDate?.getTime())).size).toBe(1);
  });

  it('taxi adoption preserves a delivery paid period, issued amount and manual restrictions', async () => {
    const userId = await makeMoverUser();
    const rider = await makeRider(userId, 'MOTORCYCLE');
    const first = await subscriptions.startTrialForRider(rider.id);
    const due = new Date(Date.now() + 3 * 86_400_000);
    await app.prisma.subscription.update({ where: { id: first.id }, data: { status: 'PAUSED', autoRenew: false, weeklyRate: 4500, customRate: 4500, currentPeriodEnd: due, nextBillingDate: due } });
    const issued = await app.prisma.subscriptionPayment.create({ data: { subscriptionId: first.id, amount: 6000, status: 'PENDING', paymentMethod: 'MOBILE_MONEY', periodStart: new Date(), periodEnd: due } });
    const driver = await makeDriver(userId, 'CAR');
    const adopted = await subscriptions.startTrialForDriver(driver.id);
    expect(adopted.id).toBe(first.id);
    expect(adopted.type).toBe('DELIVERY_RIDER');
    expect(adopted.status).toBe('PAUSED');
    expect(adopted.autoRenew).toBe(false);
    expect(Number(adopted.weeklyRate)).toBe(4500);
    expect(adopted.currentPeriodEnd.getTime()).toBe(due.getTime());
    expect(adopted.nextBillingDate.getTime()).toBe(due.getTime());
    expect(adopted.trialEndDate?.getTime()).toBe(first.trialEndDate?.getTime());
    expect(Number((await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: issued.id } })).amount)).toBe(6000);
    expect(await app.prisma.trialGrant.count({ where: { accountId: userId } })).toBe(1);
  });

  it('a legacy pair projects a hold on GET without writes and persists it on an authorized worker', async () => {
    const userId = await makeMoverUser();
    const rider = await makeRider(userId, 'MOTORCYCLE');
    const driver = await makeDriver(userId, 'CAR');
    const now = new Date();
    const common = { status: 'ACTIVE' as const, weeklyRate: 6000, currencyCode: 'GYD', currentPeriodStart: now, currentPeriodEnd: now, nextBillingDate: now };
    const r = await app.prisma.subscription.create({ data: { ...common, riderId: rider.id, type: 'DELIVERY_RIDER' } });
    const d = await app.prisma.subscription.create({ data: { ...common, driverId: driver.id, type: 'TAXI_DRIVER', weeklyRate: 9000 } });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: r.id, balance: 1000, currencyCode: 'GYD' } });
    const payer = { userId, tenantId: 'swift-default' };
    expect(await resolveMoverFeeAuthority(app.prisma, payer)).toMatchObject({ state: 'FINANCE_HOLD', sourceSubscriptionIds: [r.id, d.id].sort() });
    expect(await app.prisma.moverFeeAuthority.findUnique({ where: { userId } })).toBeNull();
    const held = await app.prisma.$transaction((tx) => lockMoverFeeAuthority(tx, payer));
    expect(held).toMatchObject({ state: 'FINANCE_HOLD', revision: 1 });
    expect(await app.prisma.moverFeeSubscription.count({ where: { userId } })).toBe(2);
    expect((await app.prisma.$transaction((tx) => lockMoverFeeAuthority(tx, payer)))?.revision).toBe(1);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: r.id } })).balance)).toBe(1000);
    await expect(app.prisma.subscription.delete({ where: { id: r.id } })).rejects.toThrow();
    await expect(app.prisma.subscription.delete({ where: { id: d.id } })).rejects.toThrow();
    await expect(app.prisma.moverFeeAuthority.delete({ where: { userId } })).rejects.toThrow();
    await expect(app.prisma.moverFeeAuthority.update({ where: { userId }, data: { state: 'ACTIVE', holdReason: null } })).rejects.toThrow();
  });

  it('a rider who buys a canter is told the heavy-delivery rate 14 days ahead (held, never written at once)', async () => {
    // The revenue leak this closes: weeklyRate is a snapshot taken at signup,
    // so without the weekly re-tier a rider who upgrades pays 6,000 forever.
    // [R27 · GUARDRAILS §7 standing rule 2] The higher fee is HELD for the 14-day
    // notice (fee-rise-notice.ts), told and applied from the first weekly fee
    // after it: the re-tier never raises a fee at once.
    const rider = await makeRider(await makeMoverUser(), 'MOTORCYCLE');
    const sub = await subscriptions.startTrialForRider(rider.id);
    expect(Number(sub.weeklyRate)).toBe(6000);

    await app.prisma.rider.update({ where: { id: rider.id }, data: { vehicleType: 'CANTER_LONG' } });
    expect(await billing.recalculateMoverTiers()).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(Number(after.weeklyRate)).toBe(6000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE' } })).toBe(0);
    const held = await app.prisma.platformConfig.findUnique({ where: { key: `billing.fee_rise:${sub.id}` } });
    expect(held?.value).toMatchObject({ from: 6000, to: 9000, source: 'WEEKLY_RETIER', noticeAt: null });

    // ...and selling the canter before it applies drops the held rise. The band is not a ratchet.
    await app.prisma.rider.update({ where: { id: rider.id }, data: { vehicleType: 'MOTORCYCLE' } });
    await billing.recalculateMoverTiers();
    const back = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(Number(back.weeklyRate)).toBe(6000);
    expect(await app.prisma.platformConfig.findUnique({ where: { key: `billing.fee_rise:${sub.id}` } })).toBeNull();
    expect(await app.prisma.auditLog.count({ where: { entityId: sub.id, action: 'BILLING_FEE_RISE_DROPPED' } })).toBe(1);
  });

  it('[R27] a lower fee applies from the next weekly fee, and the rider is told in the app', async () => {
    const userId = await makeMoverUser();
    const rider = await makeRider(userId, 'MOTORCYCLE');
    const sub = await subscriptions.startTrialForRider(rider.id);
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { weeklyRate: 8000 } });

    expect(await billing.recalculateMoverTiers()).toBeGreaterThanOrEqual(1);
    expect(Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).weeklyRate)).toBe(6000);
    const told = await app.prisma.notification.findMany({ where: { userId, title: 'Your weekly fee is going down' } });
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toBe('From your next weekly fee, your Swift weekly fee is GY$6,000 (it was GY$8,000). A weekly fee already charged keeps its amount.');
    expect(told[0]!.data).toMatchObject({ kind: 'billing_rate_change', change: 'DECREASE', subscriptionId: sub.id, weeklyFee: 6000, previousWeeklyFee: 8000 });
    // The next pass has nothing to move and tells nothing more.
    await billing.recalculateMoverTiers();
    expect(await app.prisma.notification.count({ where: { userId, title: 'Your weekly fee is going down' } })).toBe(1);
  });

  it('[R27] a re-tier rise is told 14 days ahead by the hourly pass; if the card no longer gives it, it is dropped and the rider told', async () => {
    const userId = await makeMoverUser();
    const rider = await makeRider(userId, 'MOTORCYCLE');
    const sub = await subscriptions.startTrialForRider(rider.id);
    await app.prisma.rider.update({ where: { id: rider.id }, data: { vehicleType: 'CANTER_LONG' } });
    await billing.recalculateMoverTiers();

    const now = new Date();
    await billing.sweepFeeRises(now);
    const key = `billing.fee_rise:${sub.id}`;
    const held = (await app.prisma.platformConfig.findUniqueOrThrow({ where: { key } })).value as { noticeAt: string | null; appliesFrom: string | null; to: number };
    expect(held.to).toBe(9000);
    expect(held.noticeAt).not.toBeNull();
    expect(new Date(held.appliesFrom!).getTime() - new Date(held.noticeAt!).getTime()).toBeGreaterThanOrEqual(14 * 24 * 60 * 60 * 1000);
    expect(Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).weeklyRate)).toBe(6000);
    expect(await app.prisma.notification.count({ where: { userId, title: 'Your weekly fee is changing' } })).toBe(1);

    await app.prisma.rider.update({ where: { id: rider.id }, data: { vehicleType: 'MOTORCYCLE' } });
    await billing.recalculateMoverTiers();
    expect(await app.prisma.platformConfig.findUnique({ where: { key } })).toBeNull();
    const cancelled = await app.prisma.notification.findMany({ where: { userId, title: 'Your weekly fee is not changing' } });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.body).toContain('GY$6,000');
    expect(Number((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).weeklyRate)).toBe(6000);
  });

  it('a rider still on the old 8,000 moves to 6,000 at the next weekly re-tier, with an audit event — taxi is already on 8,000', async () => {
    // The owner, 2026-09-29: delivery riders pay 6,000 a week, down from 8,000;
    // the following day taxi moved to 8,000. A rider subscription on the previous card must
    // not keep paying 8,000: the weekly re-tier moves it, and says so.
    const rider = await makeRider(await makeMoverUser(), 'MOTORCYCLE');
    const sub = await subscriptions.startTrialForRider(rider.id);
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { weeklyRate: 8000 } });
    const driver = await makeDriver(await makeMoverUser(), 'CAR');
    const taxiSub = await subscriptions.startTrialForDriver(driver.id);

    expect(await billing.recalculateMoverTiers()).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(Number(after.weeklyRate)).toBe(6000);
    const event = await app.prisma.billingEvent.findFirst({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE' } });
    expect(event).not.toBeNull();
    expect(Number(event?.amount)).toBe(6000);

    const taxi = await app.prisma.subscription.findUniqueOrThrow({ where: { id: taxiSub.id } });
    expect(Number(taxi.weeklyRate)).toBe(8000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: taxiSub.id, type: 'TIER_CHANGE' } })).toBe(0);
  });

  it('a taxi driver who buys a bus stays on the taxi rate — the role decides, not the vehicle', async () => {
    const driver = await makeDriver(await makeMoverUser(), 'CAR');
    const sub = await subscriptions.startTrialForDriver(driver.id);
    expect(Number(sub.weeklyRate)).toBe(8000);

    await app.prisma.driver.update({ where: { id: driver.id }, data: { vehicleType: 'BUS_15' } });
    await billing.recalculateMoverTiers();

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(Number(after.weeklyRate)).toBe(8000);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: 'TIER_CHANGE' } })).toBe(0);
  });

  it('a negotiated rate and a waived fee both survive the re-tier', async () => {
    // A human decided these. A vehicle swap must never silently undo one.
    const negRider = await makeRider(await makeMoverUser(), 'MOTORCYCLE');
    const negSub = await subscriptions.startTrialForRider(negRider.id);
    await app.prisma.subscription.update({
      where: { id: negSub.id },
      data: { customRate: 7500, weeklyRate: 7500 },
    });

    const waivedRider = await makeRider(await makeMoverUser(), 'MOTORCYCLE');
    const waivedSub = await subscriptions.startTrialForRider(waivedRider.id);
    await app.prisma.subscription.update({
      where: { id: waivedSub.id },
      data: { feeWaived: true, feeWaivedBy: 'founder', feeWaivedReason: 'launch partner' },
    });

    await app.prisma.rider.updateMany({
      where: { id: { in: [negRider.id, waivedRider.id] } },
      data: { vehicleType: 'BOX_TRUCK_LONG' },
    });
    await billing.recalculateMoverTiers();

    const neg = await app.prisma.subscription.findUniqueOrThrow({ where: { id: negSub.id } });
    expect(Number(neg.weeklyRate)).toBe(7500);

    const waived = await app.prisma.subscription.findUniqueOrThrow({ where: { id: waivedSub.id } });
    expect(waived.feeWaived).toBe(true);
    // Untouched: the waiver, not the band, decides what is collected.
    expect(Number(waived.weeklyRate)).toBe(6000);
  });

  it('provisioning never makes a delivery Rider of a passenger vehicle, so the 6,000 band cannot reach a car [AX332]', async () => {
    // The resolver prices a Rider by vehicle band, so a Rider on a car would
    // pay the delivery rate. No such rider exists (staging, 09-30: five riders,
    // all bicycle or motorbike) and no pricing rule is added for one. This pins
    // that neither writer of a mover's vehicle can make one: /become turns a
    // car, wagon or bus into a taxi Driver, and a delivery Rider who changes to
    // one becomes a Driver while the Rider profile keeps its cargo vehicle.
    const partners = new PartnerService(app.prisma);
    const passenger = VEHICLE_TYPES_IN_ORDER.filter((v) => isPassengerVehicle(v) && isVehicleOffered(v));
    // [VERIFY-DOCS · owner ruling 9, 6 Oct 2026 — a DELIBERATE change] both buses are hidden at launch: the
    // offered passenger vehicles are the car and the wagon, and a bus is provisioned as nothing at all.
    expect(passenger).toEqual(['CAR', 'WAGON_CAR']);
    for (const bus of ['BUS_9', 'BUS_15'] as const) {
      seq += 1;
      const busJoiner = await makeMoverUser();
      await expect(partners.becomePartner(busJoiner, { role: 'MOVER', vehicleType: bus, vehicle: { make: 'Toyota', model: 'Hiace', year: 2019, color: 'White', licensePlate: `PAX ${seq}` } }))
        .rejects.toMatchObject({ code: 'VEHICLE_NOT_OFFERED' });
      expect(await app.prisma.rider.findUnique({ where: { userId: busJoiner } }), bus).toBeNull();
      expect(await app.prisma.driver.findUnique({ where: { userId: busJoiner } }), bus).toBeNull();
    }

    for (const vehicleType of passenger) {
      seq += 1;
      const vehicle = { make: 'Toyota', model: 'Noah', year: 2019, color: 'White', licensePlate: `HAX ${seq}` };

      const joiner = await makeMoverUser();
      const joined = await partners.becomePartner(joiner, { role: 'MOVER', vehicleType, vehicle });
      expect(joined.kind, vehicleType).toBe('DRIVER');
      expect(await app.prisma.rider.findUnique({ where: { userId: joiner } }), vehicleType).toBeNull();

      const switcher = await makeMoverUser();
      expect((await partners.becomePartner(switcher, { role: 'MOVER', vehicleType: 'MOTORCYCLE' })).kind).toBe('RIDER');
      const { result } = await partners.changeVehicleWithAuthority(
        switcher,
        { vehicleType, vehicle: { ...vehicle, licensePlate: `HAX ${seq} B` } },
        async () => null,
      );
      expect(result.kind, vehicleType).toBe('DRIVER');
      const rider = await app.prisma.rider.findUniqueOrThrow({ where: { userId: switcher } });
      expect(rider.vehicleType, vehicleType).toBe('MOTORCYCLE');
    }
  });
});
