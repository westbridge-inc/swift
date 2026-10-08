/**
 * [VERIFY-DOCS · owner ruling 9, 6 Oct 2026 ~20:25 GYT] BUSES ARE HIDDEN AT LAUNCH.
 *
 * "Remove buses but should big vehicles be for airports" — ruling: BUS_9 and BUS_15 (the "Group"
 * ride class) are hidden at launch. A hired 9- or 15-seater may be neither a hire car nor a route
 * bus (lawyer question), and no pooled fares exist. Airport trips at launch use cars and wagon
 * cars. Buses come back only after the lawyer confirms the licence — by taking them out of the one
 * launch-hidden set.
 *
 * Proven through the real routes:
 *  - the price list still quotes every vehicle and marks both buses not offered (the phone app's
 *    vehicle picker, build 9 included, follows each quote's `offered` flag);
 *  - nobody signs up with, or switches to, a bus; the refusal names buses honestly;
 *  - a bus driver registered before the ruling is refused GO with that same honest message, and can
 *    change to a car (the way out the message names); nobody is half-switched;
 *  - the Group tier leaves the riders' fare estimate (build 9 renders exactly the tiers returned;
 *    its default tier, Economy, is still there), and a request for it is an unavailable tier.
 */
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
import { runWithoutTenant } from '../plugins/tenant-context';
import { authRoutes } from '../modules/auth/auth.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { LAUNCH_HIDDEN_VEHICLE_TYPES, VEHICLE_TYPES_IN_ORDER, isRideClassServed, isVehicleOffered } from '../config/vehicle-classes';
import { FareService, offeredRideClasses } from '../modules/rides/fare.service';
import { scanRideQueue } from '../modules/rides/queue.service';
import { makeDispatchService } from '../modules/dispatch/dispatch.service';
import { NotificationService } from '../modules/notification/notification.service';

const DAY = 86_400_000;
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };
// One file, one block: +592071nnnnnn.
const phoneBase = 592_071_000_000 + Math.floor(Math.random() * 900_000);
const PLATE = String(Date.now()).slice(-4);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'verify-docs-buses-test');
let app: FastifyInstance;
const users: string[] = [];
let seq = 0;

async function person(role: UserRole = 'CUSTOMER', extra: { trustLevel?: 'L2' } = {}): Promise<{ userId: string; token: string }> {
  seq += 1;
  const roles: UserRole[] = role === 'DRIVER' ? ['CUSTOMER', 'MOVER', 'DRIVER'] : ['CUSTOMER'];
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Bus', lastName: `Ruling${seq}`, roles, activeRole: role,
    isPhoneVerified: true, countryCode: 'GY', selfieCapturedAt: new Date(), avatar: `/uploads/avatars/bus-${seq}.jpg`, ...extra,
    ...(role === 'CUSTOMER' ? { customer: { create: {} } } : { lastMoverRole: 'DRIVER' as const }),
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: `bus-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: u.id, token };
}

function send(method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
}
const become = (token: string, body: Record<string, unknown>) => send('POST', '/api/v1/partner/become', token, { role: 'MOVER', acceptAgreement: true, ...body });
const change = (token: string, body: Record<string, unknown>) => send('PUT', '/api/v1/partner/vehicle', token, body);
const vehicle = (suffix: string, model = 'Hiace') => ({ make: 'Toyota', model, year: 2018, color: 'White', licensePlate: `BR${PLATE}${suffix}` });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: users } } });
    // A run of this file against code that still sells Group (a mutation) creates a ride; it must not outlive the run.
    await app.prisma.order.deleteMany({ where: { customerId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: users } } }, { driver: { userId: { in: users } } }] } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[ruling 9] both buses are priced but not offered', () => {
  it('the hidden set holds both buses beside the freight classes; cars and wagon cars stay offered', () => {
    expect([...LAUNCH_HIDDEN_VEHICLE_TYPES].sort()).toEqual(['BOX_TRUCK_LONG', 'BOX_TRUCK_SHORT', 'BUS_15', 'BUS_9', 'CANTER_LONG', 'CANTER_SHORT']);
    for (const bus of ['BUS_9', 'BUS_15'] as const) expect(isVehicleOffered(bus), bus).toBe(false);
    for (const offered of ['BICYCLE', 'MOTORCYCLE', 'CAR', 'WAGON_CAR'] as const) expect(isVehicleOffered(offered), offered).toBe(true);
  });

  it('the price list the apps read still quotes every vehicle, and marks both buses offered=false', async () => {
    const res = await send('GET', '/api/v1/auth/pricing?countryCode=GY');
    expect(res.statusCode, res.body).toBe(200);
    const movers = res.json().data.movers as Array<{ vehicleType: string; offered: boolean }>;
    expect(movers.map((m) => m.vehicleType)).toEqual(VEHICLE_TYPES_IN_ORDER);
    expect(movers.filter((m) => m.offered).map((m) => m.vehicleType)).toEqual(['BICYCLE', 'MOTORCYCLE', 'CAR', 'WAGON_CAR']);
    for (const bus of ['BUS_9', 'BUS_15']) expect(movers.find((m) => m.vehicleType === bus)?.offered, bus).toBe(false);
  });
});

describe('[ruling 9] nobody signs up with, switches to, or works a bus', () => {
  it('a bus sign-up is refused with a message that names buses; no driver is provisioned', async () => {
    for (const vehicleType of ['BUS_9', 'BUS_15']) {
      const u = await person();
      const res = await become(u.token, { vehicleType, vehicle: vehicle(vehicleType === 'BUS_9' ? 'A' : 'B') });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe('VEHICLE_NOT_OFFERED');
      expect(res.json().error.message).toMatch(/buses/);
      expect(await system(() => app.prisma.driver.count({ where: { userId: u.userId } }))).toBe(0);
    }
  });

  it('a car driver cannot switch to a bus; the car stays exactly as it was', async () => {
    const u = await person();
    const made = await become(u.token, { vehicleType: 'CAR', vehicle: vehicle('C', 'Premio') });
    expect(made.statusCode, made.body).toBe(201);
    const res = await change(u.token, { vehicleType: 'BUS_15', vehicle: vehicle('D') });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('VEHICLE_NOT_OFFERED');
    expect(res.json().error.message).toMatch(/buses/);
    expect(await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId }, select: { vehicleType: true, rideClass: true } })))
      .toEqual({ vehicleType: 'CAR', rideClass: 'ECONOMY' });
  });

  it('a bus driver registered before the ruling is refused GO with the honest message, and can change to a car', async () => {
    const u = await person('DRIVER');
    await system(() => app.prisma.driver.create({ data: {
      userId: u.userId, vehicleType: 'BUS_15', rideClass: 'GROUP', vehicleCapacity: 15, documentsVerified: false,
      vehicleMake: 'Toyota', vehicleModel: 'Coaster', vehicleYear: 2019, vehicleColor: 'White', licensePlate: `BR${PLATE}E`,
      driverLicenseUrl: 'test/bus-licence', vehicleInsuranceUrl: 'test/bus-insurance',
    } }));
    const go = await send('POST', '/api/v1/driver/go-online', u.token, { latitude: CENTRAL.lat, longitude: CENTRAL.lng });
    expect(go.statusCode, go.body).toBe(403);
    expect(go.json().error.code).toBe('VEHICLE_NOT_OFFERED');
    // Build 9 shows this message verbatim in its go-online banner.
    expect(go.json().error.message).toBe('Swift is not taking buses, canters or box trucks yet. Change your vehicle to go online.');
    expect((await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId } }))).isOnline).toBe(false);
    // The way out the message names: change to a car.
    const toCar = await change(u.token, { vehicleType: 'CAR', vehicle: vehicle('F', 'Axio') });
    expect(toCar.statusCode, toCar.body).toBe(200);
    expect(await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId }, select: { vehicleType: true, rideClass: true, vehicleCapacity: true } })))
      .toEqual({ vehicleType: 'CAR', rideClass: 'ECONOMY', vehicleCapacity: 4 });
  });
});

describe('[ruling 9] the Group tier leaves the riders’ fares', () => {
  it('a stale Group queue request is refused before replacing the customer’s offered trip', async () => {
    const { userId, token } = await person('CUSTOMER', { trustLevel: 'L2' });
    const offered = await app.prisma.rideQueueEntry.create({ data: { customerId: userId, tenantId: 'swift-default',
      pickupLat: CENTRAL.lat, pickupLng: CENTRAL.lng, pickupAddress: 'Central GT',
      dropoffLat: SOUTH.lat, dropoffLng: SOUTH.lng, dropoffAddress: 'South GT',
      rideClass: 'ECONOMY', passengerCount: 1, expiresAt: new Date(Date.now() + DAY) } });
    const res = await send('POST', '/api/v1/rides/queue/join', token, { pickup: CENTRAL, dropoff: SOUTH,
      pickupAddress: 'Central GT', dropoffAddress: 'South GT', passengerCount: 6, rideClass: 'GROUP' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('INVALID_RIDE_CLASS');
    expect(await app.prisma.rideQueueEntry.findUniqueOrThrow({ where: { id: offered.id }, select: { status: true } })).toEqual({ status: 'WAITING' });
    expect(await app.prisma.rideQueueEntry.count({ where: { customerId: userId, rideClass: 'GROUP' } })).toBe(0);
  });

  it.each([-1, 1])('an existing Group queue entry becomes terminal with one honest notice (TTL sign %s)', async (sign) => {
    const { userId } = await person('CUSTOMER', { trustLevel: 'L2' });
    const entry = await app.prisma.rideQueueEntry.create({ data: { customerId: userId, tenantId: 'swift-default',
      pickupLat: CENTRAL.lat, pickupLng: CENTRAL.lng, pickupAddress: 'Central GT',
      dropoffLat: SOUTH.lat, dropoffLng: SOUTH.lng, dropoffAddress: 'South GT',
      rideClass: 'GROUP', passengerCount: 6, expiresAt: new Date(Date.now() + sign * DAY) } });
    const scan = () => scanRideQueue(app, new FareService(app.prisma), makeDispatchService(app), new NotificationService(app.prisma, app.io));
    await scan(); await scan();
    expect((await app.prisma.rideQueueEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('EXPIRED');
    const notices = await app.prisma.notification.findMany({ where: { userId } });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/no longer offered/);
    expect(notices[0]!.data).toMatchObject({ kind: 'ride_queue_unavailable' });
    expect(notices[0]!.data).not.toHaveProperty('rideClass');
    expect(await app.prisma.order.count({ where: { customerId: userId } })).toBe(0);
  });

  it('only Economy and Comfort are offered: Group is not served while no offered vehicle serves it', () => {
    expect(offeredRideClasses()).toEqual(['ECONOMY', 'COMFORT']);
    expect(isRideClassServed('GROUP')).toBe(false);
  });

  it('the estimate a rider sees has no Group option — build 9 renders exactly these tiers, and its default (Economy) is there', async () => {
    const { token } = await person();
    const res = await send('POST', '/api/v1/rides/estimate', token, { pickup: CENTRAL, dropoff: SOUTH });
    expect(res.statusCode, res.body).toBe(200);
    const tiers = res.json().data.tiers as Array<{ rideClass: string; fare: number; capacity: number }>;
    expect(tiers.map((t) => t.rideClass)).toEqual(['ECONOMY', 'COMFORT']);
    for (const t of tiers) expect(t.fare, t.rideClass).toBeGreaterThan(0);
  });

  it('a request for the Group tier (an older screen that still holds it) is an unavailable tier, not a ride', async () => {
    // An ID-verified rider (L2), so the answer is about the tier and nothing else.
    const { userId, token } = await person('CUSTOMER', { trustLevel: 'L2' });
    const res = await send('POST', '/api/v1/rides/request', token, {
      pickup: CENTRAL, dropoff: SOUTH, pickupAddress: 'Central GT', dropoffAddress: 'South GT', passengerCount: 6, rideClass: 'GROUP',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('INVALID_RIDE_CLASS');
    expect(await system(() => app.prisma.order.count({ where: { customerId: userId } }))).toBe(0);
  });
});
