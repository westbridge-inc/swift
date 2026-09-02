import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';

// ---------------------------------------------------------------------------
// RIDES CHARACTERIZATION [rides spec 17.1/17.4] — pins the CURRENT customer
// taxi contract before the experience overhaul touches anything:
//   • the full status walk PENDING → DRIVER_ASSIGNED → EN_ROUTE → ARRIVED →
//     (PIN verify) → RIDE_IN_PROGRESS → DELIVERED, via the REAL routes both
//     apps call;
//   • every /rides/active payload field TaxiScreen reads today;
//   • the exact socket event names + rooms the mobile client subscribes to
//     (order:status_changed, driver:location's channel is exercised by the
//     GPS stream elsewhere; dispatch:exhausted covered by dispatch tests);
//   • driver-cancel = controlled release → PENDING + reason:'driver_cancelled'
//     (the T18 continuity the new UI will dress, never change).
// These must stay green through the entire engagement — the "it worked
// before" proof. Offer cascade/exhaustion mechanics live in dispatch.test /
// availability.test / supply-watch.test; PIN failure paths in
// taxi-pin-verify.test. This file is the end-to-end spine.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const phoneBase = 592_130_000_000 + Math.floor(Math.random() * 800_000_000);

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;

// Socket emission recorder: pins room + event names the client depends on.
const emitted: { room: string; event: string; payload: unknown }[] = [];

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Char',
      lastName: `U${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    } as never,
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'char-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, sessionId: session.id };
}

async function makeDriver() {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: owned.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'White',
      licensePlate: `HD 48${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      vehiclePhotoUrl: 'https://cdn.test/allion.jpg',
      isAvailable: true, isOnline: true, currentLat: 6.8013, currentLng: -58.1553,
      lastLocationUpdate: new Date(), locationSessionId: owned.sessionId,
      averageRating: 4.9,
    } as never,
  });
  return { ...owned, driverId: driver.id };
}

/** A PENDING taxi order created through the REAL request route. */
async function requestRide(customerToken: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rides/request',
    headers: { authorization: `Bearer ${customerToken}`, 'content-type': 'application/json' },
    payload: {
      pickup: { lat: 6.8013, lng: -58.1553 },
      dropoff: { lat: 6.8143, lng: -58.1443 },
      pickupAddress: 'Stabroek Market',
      dropoffAddress: 'Camp Street',
      rideClass: 'ECONOMY',
      passengerCount: 1,
    },
  });
  expect(res.statusCode).toBe(201);
  const ride = res.json().data.ride; // request answers {ride, message}
  orderIds.push(ride.id);
  return ride;
}

const driverPut = (token: string, id: string, leg: string, body: Record<string, unknown> = {}) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/driver/rides/${id}/${leg}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();

  // Record every room emission — event names are the client's contract.
  const realTo = app.io.to.bind(app.io);
  (app.io as { to: (room: string) => unknown }).to = (room: string) => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ room, event, payload });
      return realTo(room).emit(event, payload);
    },
  });
});

afterAll(async () => {
  // order_status_logs are append-only (audit law) — order delete cascades them.
  // Sweep by tracked id AND by this file's customers, so a test that creates
  // a ride through a raw inject can never strand a row that blocks user cleanup.
  await app.prisma.order.deleteMany({ where: { OR: [{ id: { in: orderIds } }, { customerId: { in: userIds } }] } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('the current taxi contract (characterization — must stay green all engagement)', () => {
  it('estimate + availability expose the exact shapes TaxiScreen reads', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await makeDriver(); // supply exists

    const est = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/estimate',
      headers: { authorization: `Bearer ${customer.token}`, 'content-type': 'application/json' },
      payload: { pickup: { lat: 6.8013, lng: -58.1553 }, dropoff: { lat: 6.8143, lng: -58.1443 } },
    });
    expect(est.statusCode).toBe(200);
    const e = est.json().data;
    expect(e).toHaveProperty('currencyCode');
    expect(e).toHaveProperty('distanceKm');
    expect(e).toHaveProperty('durationMin');
    expect(Array.isArray(e.tiers)).toBe(true);
    const tier = e.tiers.find((t: { rideClass: string }) => t.rideClass === 'ECONOMY');
    expect(tier).toMatchObject({ rideClass: 'ECONOMY' });
    for (const key of ['fare', 'capacity', 'source']) expect(tier).toHaveProperty(key);

    await app.redis.del('t:swift-default:avail:DRIVER:6.80:-58.16');
    const avail = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/availability?lat=6.8013&lng=-58.1553',
      headers: { authorization: `Bearer ${customer.token}` },
    });
    expect(avail.statusCode).toBe(200);
    expect(['GOOD', 'LOW']).toContain(avail.json().data.level);
    expect(avail.json().data.nearestEtaMinutes).toBeGreaterThanOrEqual(1);
  });

  it('walks the full lifecycle through the real routes with the real socket events', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await requestRide(customer.token);
    expect(ride.status).toBe('PENDING');

    // Driver accepts (what the driver app calls when offered).
    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/rides/${ride.id}/accept`,
      headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(accept.statusCode).toBe(200);

    // The customer payload TaxiScreen renders: EVERY field pinned.
    const active = await app.inject({
      method: 'GET', url: '/api/v1/rides/active',
      headers: { authorization: `Bearer ${customer.token}` },
    });
    const a = active.json().data;
    expect(a.status).toBe('DRIVER_ASSIGNED');
    expect(String(a.ridePin)).toMatch(/^\d{4,6}$/); // the start-code ritual's fuel
    expect(a.driver).toMatchObject({
      vehicleMake: 'Toyota',
      vehicleModel: 'Allion',
      vehicleColor: 'White',
    });
    expect(a.driver.licensePlate).toMatch(/^HD 48/);
    expect(a.driver).toHaveProperty('vehiclePhotoUrl');
    expect(a.driver.user).toHaveProperty('firstName');
    expect(a.driver.user).toHaveProperty('phone');
    expect(a).toHaveProperty('taxiFareTotal');

    // EN_ROUTE → ARRIVED → PIN → IN_PROGRESS → complete.
    expect((await driverPut(driver.token, ride.id, 'en-route')).statusCode).toBe(200);
    expect((await driverPut(driver.token, ride.id, 'arrived')).statusCode).toBe(200);
    const wrong = await driverPut(driver.token, ride.id, 'verify-pin', { pin: '000000' });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400); // wrong PIN burns, never starts
    const verified = await driverPut(driver.token, ride.id, 'verify-pin', { pin: String(a.ridePin) });
    expect(verified.statusCode).toBe(200);
    const started = await driverPut(driver.token, ride.id, 'start');
    expect(started.statusCode).toBe(200);
    // [M-29] The completion tap alone is refused for a cash ride; the fare
    // outcome at the destination is what completes it.
    expect((await driverPut(driver.token, ride.id, 'complete')).statusCode).toBe(409);
    const done = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/rides/${ride.id}/handover`,
      headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
      payload: { outcome: 'paid', gps: { lat: 6.755, lng: -58.155 } },
    });
    expect(done.statusCode).toBe(200);

    const finalOrder = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(['DELIVERED', 'COMPLETED']).toContain(finalOrder.status);

    // The socket contract: the client's room + the event name it listens to.
    const rooms = emitted.filter((m) => m.room === `order:${ride.id}`);
    const statusEvents = rooms.filter((m) => m.event === 'order:status_changed');
    expect(statusEvents.length).toBeGreaterThanOrEqual(3); // assigned/en-route/arrived/…
    const statuses = statusEvents.map((m) => (m.payload as { status: string }).status);
    expect(statuses).toContain('DRIVER_EN_ROUTE');
    expect(statuses).toContain('DRIVER_ARRIVED');
  });

  it('physical capacity is authoritative: a 9-seat bus cannot serve a 10-passenger GROUP ride at any entrance [REPORT-014 F-014-01]', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const nine = await makeDriver();
    await app.prisma.driver.update({
      where: { id: nine.driverId },
      data: { vehicleType: 'BUS_9', rideClass: 'GROUP', vehicleCapacity: 9 },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rides/request',
      headers: { authorization: `Bearer ${customer.token}`, 'content-type': 'application/json' },
      payload: {
        pickup: { lat: 6.8013, lng: -58.1553 }, dropoff: { lat: 6.8143, lng: -58.1443 },
        pickupAddress: 'Stabroek Market', dropoffAddress: 'Camp Street',
        rideClass: 'GROUP', passengerCount: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    const rideId = res.json().data.id ?? res.json().data.order?.id ?? res.json().data.ride?.id;

    // The open board hides it from the 9-seater…
    const board = await app.inject({
      method: 'GET', url: '/api/v1/driver/rides/available',
      headers: { authorization: `Bearer ${nine.token}` },
    });
    expect(board.statusCode).toBe(200);
    expect(board.json().data.some((r: { id: string }) => r.id === rideId)).toBe(false);

    // …the direct accept refuses…
    const direct = await app.inject({
      method: 'POST', url: `/api/v1/driver/rides/${rideId}/accept`,
      headers: { authorization: `Bearer ${nine.token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(direct.statusCode).toBe(400);
    expect(direct.json().error.code).toBe('CAPACITY_EXCEEDED');

    // …and the LOCKED claim is the belt: a forged offer-card accept (no
    // route pre-check on that path) still cannot commit the assignment.
    await app.redis.set(`dispatch:offer:${rideId}`, nine.driverId, 'EX', 40);
    const offerAccept = await app.inject({
      method: 'POST', url: '/api/v1/driver/offers/accept',
      headers: { authorization: `Bearer ${nine.token}`, 'content-type': 'application/json' },
      payload: { orderId: rideId },
    });
    expect(offerAccept.statusCode).toBe(409);
    expect(offerAccept.json().error.code).toBe('CAPACITY_EXCEEDED');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: rideId } });
    expect(fresh.driverId).toBeNull();
    expect(fresh.status).toBe('PENDING');
    await app.redis.del(`dispatch:offer:${rideId}`, `dispatch:mover-offer:${nine.driverId}`, `dispatch:declined:${rideId}`);

    // A 15-seater serves it fine.
    const fifteen = await makeDriver();
    await app.prisma.driver.update({
      where: { id: fifteen.driverId },
      data: { vehicleType: 'BUS_15', rideClass: 'GROUP', vehicleCapacity: 15 },
    });
    const accept15 = await app.inject({
      method: 'POST', url: `/api/v1/driver/rides/${rideId}/accept`,
      headers: { authorization: `Bearer ${fifteen.token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(accept15.statusCode).toBe(200);
  });

  it('a FORGED vehicleCapacity column cannot buy a seat — the taxonomy governs the locked claim [REPORT-016 F-016-03]', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const forger = await makeDriver();
    // The historical forgery shape: a 4-seat CAR whose stored column claims 14
    // seats and GROUP class (the old self-service writer allowed this).
    await app.prisma.driver.update({
      where: { id: forger.driverId },
      data: { vehicleType: 'CAR', rideClass: 'GROUP', vehicleCapacity: 14 },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rides/request',
      headers: { authorization: `Bearer ${customer.token}`, 'content-type': 'application/json' },
      payload: {
        pickup: { lat: 6.8013, lng: -58.1553 }, dropoff: { lat: 6.8143, lng: -58.1443 },
        pickupAddress: 'Stabroek Market', dropoffAddress: 'Camp Street',
        rideClass: 'GROUP', passengerCount: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    const rideId = res.json().data.id ?? res.json().data.order?.id ?? res.json().data.ride?.id;
    // The locked claim derives seats from vehicleType=CAR (4) via the taxonomy,
    // not the forged column — a forged offer-card accept is refused.
    await app.redis.set(`dispatch:offer:${rideId}`, forger.driverId, 'EX', 40);
    const offerAccept = await app.inject({
      method: 'POST', url: '/api/v1/driver/offers/accept',
      headers: { authorization: `Bearer ${forger.token}`, 'content-type': 'application/json' },
      payload: { orderId: rideId },
    });
    expect(offerAccept.statusCode).toBe(409);
    expect(offerAccept.json().error.code).toBe('CAPACITY_EXCEEDED');
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: rideId } });
    expect(fresh.driverId).toBeNull();
    await app.redis.del(`dispatch:offer:${rideId}`, `dispatch:mover-offer:${forger.driverId}`, `dispatch:declined:${rideId}`);
  });

  it('self-serve profile writes cannot change class or capacity [REPORT-014 F-014-01]', async () => {
    const d = await makeDriver();
    const before = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/driver/profile',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      payload: { rideClass: 'GROUP', vehicleCapacity: 15, vehicleColor: 'Black' },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect(after.rideClass).toBe(before.rideClass); // taxonomy authority — ignored
    expect(after.vehicleCapacity).toBe(before.vehicleCapacity);
    expect(after.vehicleColor).toBe('Black'); // ordinary fields still update
  });

  it('driver BOARD accept with fare 0 means NO price choice — the market fare applies, never the floor [REPORT-012 proof gap]', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await requestRide(customer.token);
    const before = await app.prisma.order.findUniqueOrThrow({
      where: { id: ride.id }, select: { taxiFareTotal: true, totalAmount: true },
    });
    // A forged/legacy client posting fare 0 on the open board must not clamp
    // the driver's own pay to the floor — zero is "no choice", market applies.
    // (The rider-board twin lives in dispatch.test.ts [REPORT-011 F-04].)
    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/rides/${ride.id}/accept`,
      headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
      payload: { fare: 0 },
    });
    expect(accept.statusCode).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(fresh.status).toBe('DRIVER_ASSIGNED');
    expect(Number(fresh.taxiFareTotal)).toBe(Number(before.taxiFareTotal));
    expect(Number(fresh.totalAmount)).toBe(Number(before.totalAmount));
  });

  it('driver cancel = controlled release: PENDING + reason driver_cancelled + honest push (T18 bones)', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriver();
    const ride = await requestRide(customer.token);
    await app.inject({
      method: 'POST',
      url: `/api/v1/driver/rides/${ride.id}/accept`,
      headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
      payload: {},
    });

    emitted.length = 0;
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/driver/rides/${ride.id}/cancel`,
      headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
      payload: { reason: 'characterization test' },
    });
    expect(cancel.statusCode).toBe(200);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.status).toBe('PENDING'); // the ride SURVIVES — continuity, not a dead end
    expect(after.driverId).toBeNull();

    const evt = emitted.find((m) => m.room === `order:${ride.id}` && m.event === 'order:status_changed');
    expect(evt?.payload).toMatchObject({ status: 'PENDING', reason: 'driver_cancelled' });

    const push = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, title: 'Finding you another driver' },
    });
    expect(push).toBeTruthy();

    // Freed driver is re-dispatchable.
    const freed = await app.prisma.driver.findFirstOrThrow({ where: { userId: driver.userId } });
    expect(freed.isAvailable).toBe(true);
  });
});
