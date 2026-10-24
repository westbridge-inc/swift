import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { grantStepUp } from './helpers/step-up';

// ---------------------------------------------------------------------------
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] Taxi passengers pay the driver
// directly at drop-off, cash or MMG, the way cash already works: the app shows
// the fare, Swift never touches the money, and there is NO in-app MMG pay link
// for drivers. The switch DRIVER_MMG_PAY_LINK turns the old link back on only
// when it is exactly '1'; unset (every environment today) means OFF.
//   OFF: no passenger surface carries the driver's link (old builds then hide
//        their "Pay with MMG instead" button), the driver's profile hides it
//        (mmgPayLinkEnabled false; build 12 hides the card), and a new link is
//        refused with a clear sentence BEFORE step-up or any money-surface write.
//   ON:  the old behaviour, unchanged.
// A stored link is never deleted by the switch: it stays dormant in the row.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const phoneBase = 592_160_000_000 + Math.floor(Math.random() * 800_000_000);
const GT = { lat: 6.8013, lng: -58.1553 };
const LINK = 'https://pay.example.com/pay/driver-off-1';

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Off', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    } as never,
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pay-off-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, sessionId: session.id };
}

async function makeDriver(link: string | null) {
  const owned = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  const d = await app.prisma.driver.create({
    data: {
      userId: owned.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2018,
      vehicleColor: 'White', licensePlate: `HP 3${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isAvailable: false, isOnline: true, currentLat: GT.lat, currentLng: GT.lng, lastLocationUpdate: new Date(),
      locationSessionId: owned.sessionId, mmgPayUrl: link,
    } as never,
  });
  return { ...owned, driverId: d.id };
}

async function makeRide(customerId: string, driverId: string, status: string) {
  seq += 1;
  return app.prisma.order.create({
    data: {
      orderNumber: `PO-${seq}-${nanoid(4)}`, orderType: 'TAXI', customerId, driverId, status,
      pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng,
      deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    } as never,
  });
}

function inject(method: 'GET' | 'PUT', url: string, token: string, payload?: unknown) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // The link itself passes every destination check: only the switch decides.
  process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.example.com';
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (userIds.length) {
    await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
    const drivers = await app.prisma.driver.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: { in: drivers.map((d) => d.id) } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('switch OFF (unset, the default everywhere)', () => {
  it('no passenger surface carries the driver link: in progress, active, receipt', async () => {
    vi.stubEnv('DRIVER_MMG_PAY_LINK', '');
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const d = await makeDriver(LINK);
    const ride = await makeRide(c.userId, d.driverId, 'RIDE_IN_PROGRESS');

    const active = await inject('GET', '/api/v1/rides/active', c.token);
    expect(active.statusCode).toBe(200);
    expect(active.json().data.driver.mmgPayUrl).toBeNull();

    await app.prisma.order.update({ where: { id: ride.id }, data: { status: 'DELIVERED' } });
    const receipt = await inject('GET', `/api/v1/rides/${ride.id}`, c.token);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().data.driver.mmgPayUrl).toBeNull();
    // Dormant, not deleted: the stored link is untouched.
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } })).mmgPayUrl).toBe(LINK);
  });

  it("the driver's profile hides the link and says the card is off", async () => {
    vi.stubEnv('DRIVER_MMG_PAY_LINK', '');
    const d = await makeDriver(LINK);
    await app.prisma.driver.update({
      where: { id: d.driverId },
      data: { mmgPayUrlPending: 'https://pay.example.com/pay/driver-off-next', mmgPayUrlPendingAt: new Date(), mmgPayUrlApplyAt: new Date(Date.now() + DAY) },
    });
    const got = await inject('GET', '/api/v1/driver/profile', d.token);
    expect(got.statusCode).toBe(200);
    const data = got.json().data;
    expect(data.mmgPayLinkEnabled).toBe(false);
    expect(data.mmgPayUrl).toBeNull();
    expect(data.mmgPayUrlPending).toBeNull();
    expect(data.mmgPayUrlApplyAt).toBeNull();
  });

  it('a new link is refused with a clear sentence before step-up, and nothing is staged', async () => {
    vi.stubEnv('DRIVER_MMG_PAY_LINK', '');
    const d = await makeDriver(null);
    // No step-up granted: the refusal must come first (a 403 step-up prompt
    // here would ask for an SMS code only to refuse afterwards).
    const res = await inject('PUT', '/api/v1/driver/profile', d.token, { mmgPayUrl: LINK });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MMG_PAY_LINK_OFF');
    expect(res.json().error.message).toBe(
      'Passengers pay you directly at drop-off, in cash or by MMG. Swift does not use an MMG pay link, so there is nothing to set up here.',
    );
    // Even with step-up the answer is the same, and no money-surface command exists.
    await grantStepUp(app, d.token);
    const again = await inject('PUT', '/api/v1/driver/profile', d.token, { mmgPayUrl: LINK });
    expect(again.statusCode).toBe(409);
    const row = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    expect([row.mmgPayUrl, row.mmgPayUrlPending]).toEqual([null, null]);
    expect(await app.prisma.moneySurfaceCommand.count({ where: { entityId: d.driverId } })).toBe(0);
  });

  it('the driver can still clear a stored link (the safe direction)', async () => {
    vi.stubEnv('DRIVER_MMG_PAY_LINK', '');
    const d = await makeDriver(LINK);
    await grantStepUp(app, d.token);
    const res = await inject('PUT', '/api/v1/driver/profile', d.token, { mmgPayUrl: '' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mmgPayLinkEnabled).toBe(false);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } })).mmgPayUrl).toBeNull();
  });

  it('only the exact value 1 turns it on: "true", "0" and "yes" stay off', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const d = await makeDriver(LINK);
    await makeRide(c.userId, d.driverId, 'RIDE_IN_PROGRESS');
    for (const value of ['true', '0', 'yes', ' 1']) {
      vi.stubEnv('DRIVER_MMG_PAY_LINK', value);
      expect((await inject('GET', '/api/v1/rides/active', c.token)).json().data.driver.mmgPayUrl).toBeNull();
      expect((await inject('GET', '/api/v1/driver/profile', d.token)).json().data.mmgPayLinkEnabled).toBe(false);
    }
  });
});

describe('switch ON (DRIVER_MMG_PAY_LINK=1): the old behaviour returns unchanged', () => {
  it('the passenger sees the link at trip end and the driver sees their card', async () => {
    vi.stubEnv('DRIVER_MMG_PAY_LINK', '1');
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const d = await makeDriver(LINK);
    await makeRide(c.userId, d.driverId, 'RIDE_IN_PROGRESS');
    expect((await inject('GET', '/api/v1/rides/active', c.token)).json().data.driver.mmgPayUrl).toBe(LINK);
    const profile = (await inject('GET', '/api/v1/driver/profile', d.token)).json().data;
    expect(profile.mmgPayLinkEnabled).toBe(true);
    expect(profile.mmgPayUrl).toBe(LINK);
  });
});
