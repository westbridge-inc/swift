import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { GuardianService, riskBand } from '../modules/safety/guardian.service';

// Trip Guardian M4b (safety spec §5.1–§5.2, self-test §14-E) — the sweep
// reconciler + L1 detectors, driven with scripted GPS exactly like the spec's
// harness case: fixes are written to the SAME persisted driver row dispatch
// reads, `now` is injected, and a FRESH GuardianService is constructed for
// every tick — so every assertion doubles as the worker-restart-survival
// proof (all detector state must live in the DB row, never in the instance).

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { emits.push({ room, event, payload }) } }),
} as unknown as Server;

// A fresh service per tick = a restarted worker per tick.
const sweep = (now: Date) => new GuardianService(prisma, io).sweep(now);

const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_710_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Guard',
      lastName: `U${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  return user;
}

/** Experienced driver by default (LOW band unless the case opts into risk). */
async function makeDriver(opts: { fresh?: boolean } = {}) {
  const user = await makeUser(['MOVER']);
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `GRD ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      totalRides: opts.fresh ? 2 : 500,
      ...(opts.fresh ? {} : { createdAt: new Date(Date.now() - 90 * 86_400_000) }),
    },
  });
  return { user, driver };
}

// Georgetown-ish geometry: pickup SW, destination NE, ~3.1 km apart.
const PICKUP = { lat: 6.8, lng: -58.15 };
const DEST = { lat: 6.82, lng: -58.13 };
const MIDWAY = { lat: 6.81, lng: -58.14 }; // ~1.56 km from DEST, far from both endpoints

async function makeRide(opts: {
  driverId: string;
  customerId: string;
  status?: string;
  pickedUpAt?: Date;
  taxiDuration?: number;
}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `GRD-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId: opts.customerId,
      driverId: opts.driverId,
      status: (opts.status ?? 'RIDE_IN_PROGRESS') as never,
      fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'B', deliveryLat: DEST.lat, deliveryLng: DEST.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      pickedUpAt: opts.pickedUpAt ?? new Date(),
      taxiDuration: opts.taxiDuration ?? 60,
    },
  });
  orderIds.push(order.id);
  return order;
}

const putFix = (driverId: string, at: Date, pos: { lat: number; lng: number }) =>
  prisma.driver.update({ where: { id: driverId }, data: { currentLat: pos.lat, currentLng: pos.lng, lastLocationUpdate: at } });

const session = (orderId: string) => prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId } });
type Flags = { deviation?: string; longStop?: string; overdue?: string; staleGps?: string };
const flagsOf = (s: { deviationState: unknown }): Flags => ((s.deviationState as { flags?: Flags } | null)?.flags ?? {});

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.sosAlert.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }] } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('Guardian sweep — session lifecycle [§5]', () => {
  it('opens exactly one session per RIDE_IN_PROGRESS taxi, with §5.1 risk factors snapshotted', async () => {
    const passenger = await makeUser(['CUSTOMER'], { enhancedSafetyMonitoring: true });
    const { driver } = await makeDriver({ fresh: true });
    // 03:00Z = 23:00 Guyana local (-4h) → NIGHT. Fresh driver → NEW_DRIVER.
    // Opted-in passenger → ENHANCED_OPT_IN. 20+15+20 = 55 = ELEVATED.
    const pickedUpAt = new Date('2026-07-30T03:00:00Z');
    const ride = await makeRide({ driverId: driver.id, customerId: passenger.id, pickedUpAt, taxiDuration: 20 });

    await sweep(new Date('2026-07-30T03:05:00Z'));
    const s = await session(ride.id);
    expect(s.status).toBe('MONITORING');
    expect(s.riskScore).toBe(55);
    expect(riskBand(s.riskScore)).toBe(1);
    expect(s.riskFactors).toEqual(expect.arrayContaining(['NIGHT', 'NEW_DRIVER', 'ENHANCED_OPT_IN']));
    expect(s.passengerUserId).toBe(passenger.id);
    expect(s.plannedEtaAt?.getTime()).toBe(pickedUpAt.getTime() + 20 * 60_000);

    // Second tick: the unique(orderId) invariant — no double-open.
    await sweep(new Date('2026-07-30T03:06:00Z'));
    expect(await prisma.tripSafetySession.count({ where: { orderId: ride.id } })).toBe(1);
  });

  it('[F-028-05] stamps the ORDER\u2019s tenant on the session — never the schema default', async () => {
    // The sweep runs from a worker with no tenant ALS, so nothing stamps the
    // create. Before the fix the session silently took `swift-default` — and
    // because TripSafetySession is tenant-scoped on the read side, a tenant-B
    // passenger's authenticated NEED_HELP could not find their own ride's
    // session: NotFound instead of the promised immediate SOS.
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const ride = await makeRide({ driverId: driver.id, customerId: passenger.id });
    // Give the ORDER a non-default tenant directly — the row is what the sweep
    // reads, and Order.tenantId is the authoritative source here.
    await prisma.$executeRaw`UPDATE orders SET "tenantId" = 'swift-default' WHERE id = ${ride.id}`;
    const other = await prisma.tenant.upsert({
      where: { id: 'guardian-tenant-b' },
      update: {},
      create: { id: 'guardian-tenant-b', name: 'Guardian Tenant B', slug: 'guardian-tenant-b' },
    });
    await prisma.order.update({ where: { id: ride.id }, data: { tenantId: other.id } });

    await sweep(new Date('2026-07-30T03:05:00Z'));

    const s = await session(ride.id);
    expect(s.tenantId).toBe(other.id);
    expect(s.tenantId).not.toBe('swift-default');
  });

  it('ignores taxis not yet in progress and non-taxi orders entirely', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const pending = await makeRide({ driverId: driver.id, customerId: passenger.id, status: 'DRIVER_EN_ROUTE' });
    await sweep(new Date());
    expect(await prisma.tripSafetySession.count({ where: { orderId: pending.id } })).toBe(0);
  });

  it('a HIGH-band trip pings the war-room proactively (§5.1)', async () => {
    const passenger = await makeUser(['CUSTOMER'], { enhancedSafetyMonitoring: true });
    const { user: driverUser, driver } = await makeDriver({ fresh: true });
    // Prior ops-coded ABUSE SOS against this driver (+30) + NIGHT (+20) +
    // NEW_DRIVER (+15) + opt-in (+20) = 85 = HIGH.
    await prisma.sosAlert.create({
      data: { actorUserId: passenger.id, actorRole: 'CUSTOMER', counterpartyUserId: driverUser.id, status: 'RESOLVED', resolutionCode: 'ABUSE' },
    });
    const ride = await makeRide({ driverId: driver.id, customerId: passenger.id, pickedUpAt: new Date('2026-07-30T03:00:00Z') });

    emits.length = 0;
    await sweep(new Date('2026-07-30T03:05:00Z'));
    const s = await session(ride.id);
    expect(s.riskScore).toBe(85);
    expect(s.riskFactors).toEqual(expect.arrayContaining(['PRIOR_SOS_ON_DRIVER']));
    const highRisk = emits.find((e) => e.event === 'guardian:high-risk');
    expect(highRisk?.room).toBe('ops:war-room');
    expect(highRisk?.payload['orderId']).toBe(ride.id);
  });

  it('closes the session when the ride completes — and the close reason says why', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const done = await makeRide({ driverId: driver.id, customerId: passenger.id });
    const gone = await makeRide({ driverId: driver.id, customerId: passenger.id });
    await sweep(new Date());

    await prisma.order.update({ where: { id: done.id }, data: { status: 'COMPLETED' } });
    await prisma.order.update({ where: { id: gone.id }, data: { status: 'CANCELLED' } });
    await sweep(new Date());

    expect((await session(done.id)).closeReason).toBe('TRIP_COMPLETED');
    expect((await session(gone.id)).closeReason).toBe('TRIP_CANCELLED');
    expect((await session(done.id)).status).toBe('CLOSED');
  });
});

describe('Guardian detectors — scripted GPS [§5.2 / self-test §14-E]', () => {
  it('a trip that converges on the destination never flags — including a brief wrong-way blip', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const ride = await makeRide({ driverId: driver.id, customerId: passenger.id });
    const t0 = Date.now();

    await putFix(driver.id, new Date(t0), MIDWAY); // ratchet ~1.56 km
    await sweep(new Date(t0));
    await putFix(driver.id, new Date(t0 + 30_000), { lat: 6.805, lng: -58.145 }); // blip AWAY (~2.34 km)
    await sweep(new Date(t0 + 30_000));
    await putFix(driver.id, new Date(t0 + 60_000), { lat: 6.815, lng: -58.135 }); // back toward (~0.78 km)
    await sweep(new Date(t0 + 60_000));
    await putFix(driver.id, new Date(t0 + 150_000), { lat: 6.818, lng: -58.132 }); // nearly there
    await sweep(new Date(t0 + 150_000));

    expect(flagsOf(await session(ride.id)).deviation).toBeUndefined();
  });

  it('sustained travel AWAY from the destination flags a deviation once, at L1, to the war-room', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const ride = await makeRide({ driverId: driver.id, customerId: passenger.id });
    const t0 = Date.now();

    await putFix(driver.id, new Date(t0), MIDWAY); // ratchet 1.56 km
    await sweep(new Date(t0));
    await putFix(driver.id, new Date(t0 + 60_000), PICKUP); // 3.11 km — diverging starts
    await sweep(new Date(t0 + 60_000));
    expect(flagsOf(await session(ride.id)).deviation).toBeUndefined(); // not sustained yet

    emits.length = 0;
    await putFix(driver.id, new Date(t0 + 180_000), { lat: 6.795, lng: -58.155 }); // further away, 120s sustained
    await sweep(new Date(t0 + 180_000));

    const flags = flagsOf(await session(ride.id));
    expect(flags.deviation).toBeTruthy();
    const flag = emits.find((e) => e.event === 'guardian:flag');
    expect(flag?.payload['kind']).toBe('deviation');
    expect(flag?.room).toBe('ops:war-room');

    // Restart-proof: the flag fired once; another tick must not re-raise it.
    emits.length = 0;
    await putFix(driver.id, new Date(t0 + 240_000), { lat: 6.79, lng: -58.16 });
    await sweep(new Date(t0 + 240_000));
    expect(emits.filter((e) => e.event === 'guardian:flag')).toHaveLength(0);
  });

  it('a mid-route stop beyond the band budget flags; the same dwell AT the destination does not', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const stopped = await makeRide({ driverId: driver.id, customerId: passenger.id });
    const t0 = Date.now();

    await putFix(driver.id, new Date(t0), MIDWAY);
    await sweep(new Date(t0)); // anchor set
    await putFix(driver.id, new Date(t0 + 310_000), MIDWAY); // 5m10s later, same spot (LOW budget = 5m)
    await sweep(new Date(t0 + 310_000));
    expect(flagsOf(await session(stopped.id)).longStop).toBeTruthy();

    // Alighting at the destination is a legitimate stop — suppressed (§5.2).
    await prisma.order.update({ where: { id: stopped.id }, data: { status: 'COMPLETED' } });
    const arriving = await makeRide({ driverId: driver.id, customerId: passenger.id });
    const t1 = t0 + 600_000;
    await putFix(driver.id, new Date(t1), { lat: 6.8201, lng: -58.1301 }); // ~15 m from dest
    await sweep(new Date(t1));
    await putFix(driver.id, new Date(t1 + 400_000), { lat: 6.8201, lng: -58.1301 });
    await sweep(new Date(t1 + 400_000));
    expect(flagsOf(await session(arriving.id)).longStop).toBeUndefined();
  });

  it('a ride past its planned ETA + allowance flags overdue — even with no fresh fix at all', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const pickedUpAt = new Date();
    const ride = await makeRide({ driverId: driver.id, customerId: passenger.id, pickedUpAt, taxiDuration: 20 });
    await sweep(pickedUpAt);

    // allowance = max(15 min floor, 50% × 20 min) = 15 min → overdue at +35 min.
    await sweep(new Date(pickedUpAt.getTime() + 34 * 60_000));
    expect(flagsOf(await session(ride.id)).overdue).toBeUndefined();
    await sweep(new Date(pickedUpAt.getTime() + 36 * 60_000));
    expect(flagsOf(await session(ride.id)).overdue).toBeTruthy();
  });

  it('frozen telemetry cannot fake a stop — it raises staleGps instead, and recovers', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const { driver } = await makeDriver();
    const ride = await makeRide({ driverId: driver.id, customerId: passenger.id });
    const t0 = Date.now();

    await putFix(driver.id, new Date(t0), MIDWAY);
    await sweep(new Date(t0)); // anchor + consume the fix
    // 6 minutes pass with NO new fix: the stop timer must not advance (it runs
    // on the fix clock), but the stale-telemetry signal must fire.
    await sweep(new Date(t0 + 360_000));
    const flags = flagsOf(await session(ride.id));
    expect(flags.longStop).toBeUndefined();
    expect(flags.staleGps).toBeTruthy();

    // Telemetry recovers → the stale flag clears so a later stall re-arms.
    await putFix(driver.id, new Date(t0 + 400_000), { lat: 6.812, lng: -58.138 });
    await sweep(new Date(t0 + 400_000));
    expect(flagsOf(await session(ride.id)).staleGps).toBeUndefined();
  });
});
