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
import { VEHICLE_CLASSES, feeBandFor } from '../config/vehicle-classes';
import { moverRateFor, vendorRateFor, type SubscriptionTiers } from '../modules/country/country-config.service';

// ---------------------------------------------------------------------------
// The mover weekly fee has TWO bands, and which one a mover pays follows the
// VEHICLE they have registered — not the service they perform, and not the
// rate they happened to sign up on.
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
  const tiers: SubscriptionTiers = { mover: 10000, moverHeavy: 12000, smallVendor: 20000, largeVendor: 30000 };

  it('resolves each vehicle to its band rate', () => {
    for (const v of STANDARD_VEHICLES) expect(moverRateFor(tiers, v)).toBe(10000);
    for (const v of HEAVY_VEHICLES) expect(moverRateFor(tiers, v)).toBe(12000);
  });

  it('a market with no heavy rate falls back to the standard rate — never 0, never undefined', () => {
    const noHeavy: SubscriptionTiers = { mover: 10000, smallVendor: 20000, largeVendor: 30000 };
    for (const v of HEAVY_VEHICLES) {
      expect(moverRateFor(noHeavy, v)).toBe(10000);
      expect(Number.isFinite(moverRateFor(noHeavy, v))).toBe(true);
    }
  });
});

describe('vendor rate — services, catalogue tiers and the franchise discount', () => {
  const tiers: SubscriptionTiers = {
    mover: 10000, moverHeavy: 12000, serviceVendor: 12000,
    smallVendor: 20000, largeVendor: 30000, departmentVendor: 50000,
    largeCatalogueThreshold: 1000, departmentCatalogueThreshold: 10000,
    franchiseMinLocations: 5, franchiseDiscountPct: 50,
  };
  const shop = (activeListings: number, ownedStores = 1) =>
    vendorRateFor(tiers, { isService: false, activeListings, ownedStores });

  it('a service carries no catalogue and pays the service rate', () => {
    expect(vendorRateFor(tiers, { isService: true, activeListings: 0, ownedStores: 1 }))
      .toEqual({ rate: 12000, reason: 'service', franchised: false });
  });

  it('catalogue tiers step at their thresholds, and the threshold itself qualifies', () => {
    expect(shop(0).rate).toBe(20000);
    expect(shop(999).rate).toBe(20000);
    expect(shop(1000)).toEqual({ rate: 30000, reason: 'large', franchised: false });
    expect(shop(9999).rate).toBe(30000);
    expect(shop(10000)).toEqual({ rate: 50000, reason: 'department', franchised: false });
  });

  it('five shops pay 50,000 in total — the founder rate card, exactly', () => {
    expect(shop(50, 4).rate).toBe(20000); // four stores: no discount yet
    const five = shop(50, 5);
    expect(five).toEqual({ rate: 10000, reason: 'small', franchised: true });
    expect(five.rate * 5).toBe(50000);
    expect(shop(50, 10).rate * 10).toBe(100000); // scales linearly, no cliff
  });

  it('the discount applies to each location OWN tier — it never erases catalogue scale', () => {
    // The loophole this closes: a flat 50,000 bundle would let five department
    // stores pay less than one does alone.
    expect(shop(20000, 5)).toEqual({ rate: 25000, reason: 'department', franchised: true });
    expect(shop(20000, 5).rate * 5).toBe(125000); // discounted, still not 50,000
    expect(shop(20000, 5).rate).toBeGreaterThan(shop(50, 5).rate);
    expect(shop(5000, 5)).toEqual({ rate: 15000, reason: 'large', franchised: true });
    expect(vendorRateFor(tiers, { isService: true, activeListings: 0, ownedStores: 5 }))
      .toEqual({ rate: 6000, reason: 'service', franchised: true });
  });

  it('a single department store never pays less than a chain member of the same size', () => {
    // The ordering invariant the flat bundle broke.
    expect(shop(20000, 1).rate).toBeGreaterThanOrEqual(shop(20000, 5).rate);
  });

  it('a market that has priced none of the new tiers behaves exactly as before', () => {
    const legacy: SubscriptionTiers = { mover: 10000, smallVendor: 20000, largeVendor: 30000 };
    expect(vendorRateFor(legacy, { isService: true, activeListings: 0, ownedStores: 1 }).rate).toBe(20000);
    const many = vendorRateFor(legacy, { isService: false, activeListings: 50000, ownedStores: 9 });
    expect(many.rate).toBe(30000);
    expect(many.franchised).toBe(false); // no franchise config = no discount
  });
});

describe('mover fee band — what a mover is actually charged', () => {
  let app: FastifyInstance;
  let billing: BillingService;
  let subscriptions: SubscriptionService;
  const createdUserIds: string[] = [];
  let seq = 0;

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
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('the SEEDED Guyana rate card matches the founder rate card exactly', async () => {
    // Read from the CountryConfig row the public pricing endpoint serves, so a
    // stale database fails loudly instead of testing a number nobody ships.
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const seeded = gy.subscriptionTiers as unknown as SubscriptionTiers;
    expect(seeded, 'GY rate card — re-run the seed if this fails').toMatchObject({
      mover: 10000, moverHeavy: 12000, serviceVendor: 12000,
      smallVendor: 20000, largeVendor: 30000, departmentVendor: 50000,
      largeCatalogueThreshold: 1000, departmentCatalogueThreshold: 10000,
      franchiseMinLocations: 5, franchiseDiscountPct: 50,
    });
  });

  async function makeMoverUser() {
    seq += 1;
    const user = await app.prisma.user.create({
      data: {
        phone: `+59200077${String(seq).padStart(2, '0')}`,
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

  it('a motorbike delivery rider signs up on 10,000', async () => {
    const userId = await makeMoverUser();
    const rider = await app.prisma.rider.create({
      data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
    });
    const sub = await subscriptions.startTrialForRider(rider.id);
    expect(Number(sub.weeklyRate)).toBe(10000);
  });

  it('a canter courier signs up on 12,000 — the same service, the bigger vehicle', async () => {
    const userId = await makeMoverUser();
    const rider = await app.prisma.rider.create({
      data: { userId, riderType: 'COURIER', vehicleType: 'CANTER_LONG' },
    });
    const sub = await subscriptions.startTrialForRider(rider.id);
    expect(Number(sub.weeklyRate)).toBe(12000);
  });

  it('a car taxi driver signs up on 10,000, a 15-seater bus driver on 12,000', async () => {
    const car = await makeDriver(await makeMoverUser(), 'CAR');
    expect(Number((await subscriptions.startTrialForDriver(car.id)).weeklyRate)).toBe(10000);

    const bus = await makeDriver(await makeMoverUser(), 'BUS_15');
    expect(Number((await subscriptions.startTrialForDriver(bus.id)).weeklyRate)).toBe(12000);
  });

  it('buying a bigger vehicle moves the mover onto the heavy rate, with an audit event', async () => {
    // The revenue leak this closes: weeklyRate is a snapshot taken at signup,
    // so without the weekly re-tier a driver who upgrades pays 10,000 forever.
    const driver = await makeDriver(await makeMoverUser(), 'CAR');
    const sub = await subscriptions.startTrialForDriver(driver.id);
    expect(Number(sub.weeklyRate)).toBe(10000);

    await app.prisma.driver.update({ where: { id: driver.id }, data: { vehicleType: 'BUS_15' } });
    expect(await billing.recalculateMoverTiers()).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(Number(after.weeklyRate)).toBe(12000);

    const event = await app.prisma.billingEvent.findFirst({
      where: { subscriptionId: sub.id, type: 'TIER_CHANGE' },
    });
    expect(event).not.toBeNull();
    expect(Number(event?.amount)).toBe(12000);

    // ...and it moves back down when they sell the bus. The band is not a ratchet.
    await app.prisma.driver.update({ where: { id: driver.id }, data: { vehicleType: 'CAR' } });
    await billing.recalculateMoverTiers();
    const back = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(Number(back.weeklyRate)).toBe(10000);
  });

  it('a negotiated rate and a waived fee both survive the re-tier', async () => {
    // A human decided these. A vehicle swap must never silently undo one.
    const negDriver = await makeDriver(await makeMoverUser(), 'CAR');
    const negSub = await subscriptions.startTrialForDriver(negDriver.id);
    await app.prisma.subscription.update({
      where: { id: negSub.id },
      data: { customRate: 7500, weeklyRate: 7500 },
    });

    const waivedDriver = await makeDriver(await makeMoverUser(), 'CAR');
    const waivedSub = await subscriptions.startTrialForDriver(waivedDriver.id);
    await app.prisma.subscription.update({
      where: { id: waivedSub.id },
      data: { feeWaived: true, feeWaivedBy: 'founder', feeWaivedReason: 'launch partner' },
    });

    await app.prisma.driver.updateMany({
      where: { id: { in: [negDriver.id, waivedDriver.id] } },
      data: { vehicleType: 'BOX_TRUCK_LONG' },
    });
    await billing.recalculateMoverTiers();

    const neg = await app.prisma.subscription.findUniqueOrThrow({ where: { id: negSub.id } });
    expect(Number(neg.weeklyRate)).toBe(7500);

    const waived = await app.prisma.subscription.findUniqueOrThrow({ where: { id: waivedSub.id } });
    expect(waived.feeWaived).toBe(true);
    // Untouched: the waiver, not the band, decides what is collected.
    expect(Number(waived.weeklyRate)).toBe(10000);
  });
});
