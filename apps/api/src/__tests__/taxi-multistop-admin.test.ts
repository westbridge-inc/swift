import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { TaxiStopStatus, UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 8/8] Operations and the passenger's paper trail: the
// console's order page shows a ride's stops in order, each with its progress
// and the arrival's evidence note (for a person reviewing the ride), and the
// passenger's receipt names the stops the fare covered, a skipped one marked.
// A ride without stops gains no key and no line. Rides are made directly
// (the read is the subject, not the booking).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = '+5923433';
const FIXTURE = 'taxi-multistop-admin';
const SUPER_ADMIN_PHONE = '+5926001000';

let app: FastifyInstance;
let adminToken = '';
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`, firstName: 'Ledger', lastName: `U${seq}`, roles, activeRole,
      isPhoneVerified: true, countryCode: 'GY',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `ledger-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

type StopSpec = { address: string; status: TaxiStopStatus; arrivedAt?: Date; departedAt?: Date; skippedAt?: Date; skipReason?: string; evidenceNote?: string };

async function makeRide(status: 'RIDE_IN_PROGRESS' | 'DELIVERED', stops: StopSpec[] | null) {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const driverUser = await makeUser(['DRIVER'], 'DRIVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: driverUser.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
      licensePlate: `HL ${8000 + seq}`, driverLicenseUrl: 'storage://ledger/dl.jpg', vehicleInsuranceUrl: 'storage://ledger/ins.jpg',
    },
  }));
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `LEDGER-${nanoid(8)}`, orderType: 'TAXI', customerId: customer.userId, driverId: driver.id, status,
      pickupAddress: 'Bartica Police Station', pickupLat: 6.406, pickupLng: -58.623,
      deliveryAddress: 'Bartica Airstrip', deliveryLat: 6.418, deliveryLng: -58.63,
      taxiPickupAddress: 'Bartica Police Station', taxiDropoffAddress: 'Bartica Airstrip',
      subtotalBase: 2800, subtotalMarkup: 0, subtotalCustomer: 2800, deliveryFee: 0,
      taxiFareTotal: 2800, totalAmount: 2800, paymentMethod: 'CASH', paymentStatus: status === 'DELIVERED' ? 'CAPTURED' : 'PENDING',
      ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      ...(stops ? {
        taxiStopCount: stops.length,
        taxiStops: {
          create: stops.map((s, i) => ({
            sequence: i + 1, lat: 6.41 + i * 0.003, lng: -58.62 - i * 0.003, address: s.address, status: s.status,
            arrivedAt: s.arrivedAt ?? null, departedAt: s.departedAt ?? null, skippedAt: s.skippedAt ?? null,
            skipReason: s.skipReason ?? null, evidenceNote: s.evidenceNote ?? null,
          })),
        },
      } : {}),
    },
  }));
  return { order, customer };
}

async function purge() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const driverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.order.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { driverId: { in: driverIds } }] } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

const call = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await purge();
  const login = await loginWithOtp(app, SUPER_ADMIN_PHONE);
  adminToken = login.json().data.tokens.accessToken;
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('the console\'s order page', () => {
  it('a ride with stops: each stop in order with its progress and the arrival evidence note, and the next one', async () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 18, 20, min));
    const { order } = await makeRide('RIDE_IN_PROGRESS', [
      { address: 'Bartica Stelling', status: 'DEPARTED', arrivedAt: at(0), departedAt: at(6), evidenceNote: 'Driver reported arriving at stop 1 — fix 5s old' },
      { address: 'Second Avenue', status: 'SKIPPED', skippedAt: at(15), skipReason: 'Road flooded' },
      { address: 'Bartica Hospital', status: 'ARRIVED', arrivedAt: at(20), evidenceNote: 'Driver reported arriving at stop 3 — no location fix on record at the time' },
    ]);
    const res = await call(`/api/v1/admin/orders/${order.id}`, adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.nextStopSequence).toBe(3);
    expect(data.stops).toEqual([
      { sequence: 1, address: 'Bartica Stelling', lat: 6.41, lng: -58.62, status: 'DEPARTED', legMeters: null, legSeconds: null,
        arrivedAt: at(0).toISOString(), departedAt: at(6).toISOString(), skippedAt: null, skipReason: null, evidenceNote: 'Driver reported arriving at stop 1 — fix 5s old' },
      { sequence: 2, address: 'Second Avenue', lat: 6.413, lng: -58.623, status: 'SKIPPED', legMeters: null, legSeconds: null,
        arrivedAt: null, departedAt: null, skippedAt: at(15).toISOString(), skipReason: 'Road flooded', evidenceNote: null },
      { sequence: 3, address: 'Bartica Hospital', lat: 6.416, lng: -58.626, status: 'ARRIVED', legMeters: null, legSeconds: null,
        arrivedAt: at(20).toISOString(), departedAt: null, skippedAt: null, skipReason: null, evidenceNote: 'Driver reported arriving at stop 3 — no location fix on record at the time' },
    ]);
  });

  it('a ride without stops gains no stop key', async () => {
    const { order } = await makeRide('RIDE_IN_PROGRESS', null);
    const data = (await call(`/api/v1/admin/orders/${order.id}`, adminToken)).json().data;
    expect(data.id).toBe(order.id);
    expect(data).not.toHaveProperty('stops');
    expect(data).not.toHaveProperty('nextStopSequence');
  });
});

describe('the passenger\'s receipt', () => {
  it('names the stops the fare covered, in order, a skipped one marked; a ride without stops has no such line', async () => {
    const { order, customer } = await makeRide('DELIVERED', [
      { address: 'Bartica Stelling', status: 'DEPARTED', arrivedAt: new Date(), departedAt: new Date() },
      { address: '"><img src=x onerror=alert(1)>', status: 'SKIPPED', skippedAt: new Date(), skipReason: 'Road flooded' },
      { address: '<script>alert(1)</script> Hospital', status: 'DEPARTED', arrivedAt: new Date(), departedAt: new Date() },
    ]);
    const res = await call(`/api/v1/customer/orders/${order.id}/receipt`, customer.token);
    expect(res.statusCode, res.body).toBe(200);
    // A stop address is text the passenger typed: it is escaped, never markup.
    expect(res.body).toContain('Stops: 1. Bartica Stelling · 2. &quot;&gt;&lt;img src=x onerror=alert(1)&gt; (skipped) · 3. &lt;script&gt;alert(1)&lt;/script&gt; Hospital');
    expect(res.body).not.toContain('<img');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('Road flooded');

    const plain = await makeRide('DELIVERED', null);
    const plainRes = await call(`/api/v1/customer/orders/${plain.order.id}/receipt`, plain.customer.token);
    expect(plainRes.statusCode, plainRes.body).toBe(200);
    expect(plainRes.body).not.toContain('Stops:');
  });
});
