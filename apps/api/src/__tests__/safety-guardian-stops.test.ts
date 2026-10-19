import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { GuardianService } from '../modules/safety/guardian.service';
import { computeActiveLegEta } from '../modules/dispatch/live-eta';
import { getMapsProvider } from '../providers/maps/maps-provider';
import { testPrismaClient } from './helpers/test-prisma-client';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 5/8] Safety across a ride's stops. Without this, a ride
// heading for a stop the passenger chose away from the destination, or the
// car waiting at a stop, reads to Trip Guardian as a deviation or a long stop.
// A false flag starts the check-in ladder, and the ladder can climb to an
// automatic SOS. Scripted GPS on the persisted driver row and a fresh
// GuardianService on every tick, exactly as safety-guardian-sweep does:
//
//  - the detectors aim at the NEXT open stop and start a new baseline when
//    the target changes (after the last stop, the destination);
//  - the stop the ride is heading for (where the car waits) is an endpoint,
//    so no long-stop flag there; mid-route dwell elsewhere still flags;
//  - the overdue allowance grows by 10 minutes per stop plus the measured
//    wait at each;
//  - a trip that ended unpaid at the stop the car waited at is not "completed
//    far from its destination";
//  - the live ETA during the trip is to the next open stop.
//
// A ride without stops is unchanged (safety-guardian-sweep, live-eta).
// ---------------------------------------------------------------------------

const prisma = testPrismaClient();

const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { emits.push({ room, event, payload }); } }),
} as unknown as Server;

// A fresh service per tick = a restarted worker per tick.
const sweep = (now: Date) => new GuardianService(prisma, io).sweep(now);

const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Stopguard',
      lastName: `U${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  return user;
}

/** An experienced driver (LOW band: deviation 500 m, long stop 5 min). */
async function makeDriver() {
  const user = await makeUser(['MOVER']);
  return prisma.driver.create({
    data: {
      userId: user.id,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `SGD ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      totalRides: 500, createdAt: new Date(Date.now() - 90 * 86_400_000),
    },
  });
}

// On one line, south-west to north-east: STOP_FAR — PICKUP — MID — DEST, ~3.1 km apart each.
const DEST = { lat: 4.32, lng: -58.68 };
const PICKUP = { lat: 4.3, lng: -58.7 };
const MID = { lat: 4.31, lng: -58.69 }; // ~1.57 km from both the pickup and the destination
const STOP_FAR = { lat: 4.28, lng: -58.72 }; // the passenger's stop, AWAY from the destination

type StopSpec = { at: { lat: number; lng: number }; status?: 'PENDING' | 'ARRIVED' | 'DEPARTED'; arrivedAt?: Date; departedAt?: Date };

async function makeRide(stops: StopSpec[], opts: { pickedUpAt?: Date; taxiDuration?: number } = {}) {
  const passenger = await makeUser(['CUSTOMER']);
  const driver = await makeDriver();
  const order = await prisma.order.create({
    data: {
      orderNumber: `SGD-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId: passenger.id,
      driverId: driver.id,
      status: 'RIDE_IN_PROGRESS',
      fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'B', deliveryLat: DEST.lat, deliveryLng: DEST.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      pickedUpAt: opts.pickedUpAt ?? new Date(),
      taxiDuration: opts.taxiDuration ?? 60,
      taxiStopCount: stops.length,
      taxiStops: {
        create: stops.map((s, i) => ({
          sequence: i + 1, lat: s.at.lat, lng: s.at.lng, address: `Stop ${i + 1}`,
          status: s.status ?? 'PENDING', arrivedAt: s.arrivedAt ?? null, departedAt: s.departedAt ?? null,
        })),
      },
    },
  });
  orderIds.push(order.id);
  return { order, driver };
}

const putFix = (driverId: string, at: Date, pos: { lat: number; lng: number }) =>
  prisma.driver.update({ where: { id: driverId }, data: { currentLat: pos.lat, currentLng: pos.lng, lastLocationUpdate: at } });
/** One tick with a fresh fix at `pos`, `ms` after t0. */
const tick = async (driverId: string, t0: number, ms: number, pos: { lat: number; lng: number }) => {
  await putFix(driverId, new Date(t0 + ms), pos);
  await sweep(new Date(t0 + ms));
};
/** Ends a case's ride (cancelled: no completion check) so later ticks leave its session alone. */
const retire = async (orderId: string, at: Date) => {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: at } });
  await sweep(at);
};
const setStop = (orderId: string, sequence: number, data: Record<string, unknown>) =>
  prisma.taxiTripStop.updateMany({ where: { orderId, sequence }, data });

type DetectorState = { flags?: { deviation?: string; longStop?: string; overdue?: string }; targetKey?: string; completionFlag?: unknown; events?: Array<{ kind: string; detail?: Record<string, unknown> }> };
const stateOf = async (orderId: string) => ((await prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId } })).deviationState as DetectorState | null) ?? {};
const flagsOf = async (orderId: string) => (await stateOf(orderId)).flags ?? {};

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.incidentCase.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.sosAlert.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('Guardian aims at the next open stop', () => {
  it('heading for a stop away from the destination is the route, not a deviation; after the stop the destination is the target, on a fresh baseline, and a real deviation still flags', async () => {
    const { order, driver } = await makeRide([{ at: STOP_FAR }]);
    const t0 = Date.now();
    // Pickup → the stop: ~0.8 km further from the destination every minute.
    await tick(driver.id, t0, 0, { lat: 4.295, lng: -58.705 });
    await tick(driver.id, t0, 60_000, { lat: 4.29, lng: -58.71 });
    await tick(driver.id, t0, 180_000, { lat: 4.285, lng: -58.715 });
    expect((await flagsOf(order.id)).deviation, 'the way to the stop is not a deviation').toBeUndefined();
    expect((await stateOf(order.id)).targetKey).toBe('STOP_1');

    // At the stop, then on to the destination: a new target, a new baseline.
    await setStop(order.id, 1, { status: 'DEPARTED', arrivedAt: new Date(t0 + 200_000), departedAt: new Date(t0 + 230_000) });
    await tick(driver.id, t0, 240_000, STOP_FAR);
    const changed = await stateOf(order.id);
    expect(changed.targetKey).toBe('DESTINATION');
    expect(changed.events?.find((e) => e.kind === 'TARGET_CHANGED')?.detail).toEqual({ from: 'STOP_1', to: 'DESTINATION' });
    await tick(driver.id, t0, 300_000, { lat: 4.29, lng: -58.71 });
    await tick(driver.id, t0, 330_000, { lat: 4.295, lng: -58.705 });
    expect((await flagsOf(order.id)).deviation, 'closing on the destination from the stop').toBeUndefined();

    // Then away from the destination, sustained: still flagged, naming the target.
    emits.length = 0;
    await tick(driver.id, t0, 390_000, { lat: 4.275, lng: -58.725 });
    await tick(driver.id, t0, 510_000, { lat: 4.27, lng: -58.73 });
    expect((await flagsOf(order.id)).deviation).toBeTruthy();
    expect(emits.find((e) => e.event === 'guardian:flag')?.payload).toMatchObject({ kind: 'deviation', target: 'DESTINATION' });
    await retire(order.id, new Date(t0 + 520_000));
  });

  it('the car waiting at its stop is not a long stop; the same dwell elsewhere mid-route still is', async () => {
    const t0 = Date.now();
    const { order, driver } = await makeRide([{ at: MID, status: 'ARRIVED', arrivedAt: new Date(t0) }]);
    await tick(driver.id, t0, 0, MID);
    await tick(driver.id, t0, 310_000, MID); // 5 min 10 s at the stop (LOW budget 5 min)
    expect((await flagsOf(order.id)).longStop, 'waiting at the stop').toBeUndefined();

    await setStop(order.id, 1, { status: 'DEPARTED', departedAt: new Date(t0 + 320_000) });
    const elsewhere = { lat: 4.315, lng: -58.685 }; // ~0.8 km on, far from every endpoint
    await tick(driver.id, t0, 330_000, elsewhere);
    await tick(driver.id, t0, 640_000, elsewhere);
    expect((await flagsOf(order.id)).longStop, 'a stop that is not on the itinerary').toBeTruthy();
    await retire(order.id, new Date(t0 + 650_000));
  });

  it('the overdue allowance grows by 10 minutes per stop plus the measured wait at it', async () => {
    const T = Date.now();
    const at = (min: number) => new Date(T + min * 60_000);
    // Planned 20 min; without stops the allowance is max(15, 10) = 15 → overdue after T+35.
    const { order } = await makeRide([{ at: MID, status: 'ARRIVED', arrivedAt: at(10) }], { pickedUpAt: at(0), taxiDuration: 20 });
    await sweep(at(0));
    // Waiting at the stop since T+10: at T+40 the allowance is 15 + 10 + 30 = 55 → not overdue.
    await sweep(at(40));
    expect((await flagsOf(order.id)).overdue, 'the passenger is at their stop').toBeUndefined();
    // Left at T+35 (a 25-minute wait): allowance 15 + 10 + 25 = 50 → overdue after T+70.
    await setStop(order.id, 1, { status: 'DEPARTED', departedAt: at(35) });
    await sweep(at(69));
    expect((await flagsOf(order.id)).overdue).toBeUndefined();
    await sweep(at(71));
    expect((await flagsOf(order.id)).overdue).toBeTruthy();
    await retire(order.id, at(72));
  });

  it('the forgiven wait is capped at 30 minutes: a car parked at its ARRIVED stop past it arms the long-stop timer again', async () => {
    const t0 = Date.now();
    const { order, driver } = await makeRide([{ at: MID, status: 'ARRIVED', arrivedAt: new Date(t0) }]);
    for (const min of [0, 10, 20, 29]) await tick(driver.id, t0, min * 60_000, MID);
    expect((await flagsOf(order.id)).longStop, 'inside the forgiven wait').toBeUndefined();
    await tick(driver.id, t0, 31 * 60_000, MID); // past the cap: the stop is no longer an endpoint, the timer anchors
    await tick(driver.id, t0, 37 * 60_000, MID); // 6 minutes later (LOW budget 5 min)
    expect((await flagsOf(order.id)).longStop, 'parked at the stop for 37 minutes').toBeTruthy();
    await retire(order.id, new Date(t0 + 38 * 60_000));
  });

  it('the forgiven wait is capped at 30 minutes: a car that never leaves its ARRIVED stop is overdue in the end', async () => {
    const T = Date.now();
    const at = (min: number) => new Date(T + min * 60_000);
    // Planned 20, arrived at T+10 and never left: allowance 15 + 10 + min(wait, 30) = 55 at most → overdue after T+75.
    const { order } = await makeRide([{ at: MID, status: 'ARRIVED', arrivedAt: at(10) }], { pickedUpAt: at(0), taxiDuration: 20 });
    await sweep(at(0));
    await sweep(at(74));
    expect((await flagsOf(order.id)).overdue).toBeUndefined();
    await sweep(at(76));
    expect((await flagsOf(order.id)).overdue, 'still parked at the stop 66 minutes on').toBeTruthy();
    await retire(order.id, at(77));
  });

  it('a trip that ended unpaid at the stop the car waited at is not "completed far from its destination"', async () => {
    const t0 = Date.now();
    const { order, driver } = await makeRide([{ at: STOP_FAR, status: 'ARRIVED', arrivedAt: new Date(t0) }]);
    await tick(driver.id, t0, 0, STOP_FAR); // the session consumes its last fix at the stop (~6.3 km from the destination)
    await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
    await sweep(new Date(t0 + 60_000));
    const closed = await prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(closed.status).toBe('CLOSED');
    expect((closed.deviationState as DetectorState).completionFlag).toBeUndefined();
    expect(await prisma.incidentCase.count({ where: { orderId: order.id, category: 'COMPLETION_ANOMALY' } })).toBe(0);
  });
});

describe('the live ETA during the trip', () => {
  it('is to the next open stop, and to the destination once every stop is done', async () => {
    const { order } = await makeRide([{ at: STOP_FAR }]);
    const mover = { lat: 4.295, lng: -58.705 }; // ~2.4 km from the stop, ~3.9 km from the destination, ~0.8 km from the pickup
    const minutesTo = async (target: { lat: number; lng: number }) => Math.max(1, Math.round((await getMapsProvider().etaMinutes(mover, [target]))[0]!));
    const toStop = await minutesTo(STOP_FAR);
    const toDest = await minutesTo(DEST);
    const toPickup = await minutesTo(PICKUP);
    expect(new Set([toStop, toDest, toPickup]).size).toBe(3);
    // Before the trip the leg is to the pickup, stops or not.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'DRIVER_EN_ROUTE' } });
    expect(await computeActiveLegEta({ prisma } as never, order.id, mover)).toBe(toPickup);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'RIDE_IN_PROGRESS' } });
    expect(await computeActiveLegEta({ prisma } as never, order.id, mover)).toBe(toStop);
    await setStop(order.id, 1, { status: 'SKIPPED', skippedAt: new Date(), skipReason: 'Road closed' });
    expect(await computeActiveLegEta({ prisma } as never, order.id, mover)).toBe(toDest);
  });
});
