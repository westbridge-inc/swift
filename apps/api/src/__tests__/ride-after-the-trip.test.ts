// [BUG-HUNT-2 G05 + G06] A ride stuck on five wrong codes has a door at support, and a finished ride can be read back. Through
// the real routes on a real database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { adminRoutes } from '../modules/admin/admin.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { handoverCodeMatches } from '../modules/handover/handover-security';
import { grantStepUp } from './helpers/step-up';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone } from './helpers/fixture-ids';

const DAY = 86_400_000;
const REASON = 'The driver mistyped the code five times at the pickup';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:ride-after-the-trip');
type Actor = { id: string; token: string };

let app: FastifyInstance;
let admin: Actor;
const people: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];
const clusterIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole, adminRow = false): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Dan', lastName: 'Trip', roles, activeRole: active, status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...(adminRow ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'trip', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: user.id, token };
}

async function ride(status: OrderStatus, over: Record<string, unknown> = {}, passenger?: Actor) {
  const customer = passenger ?? await actor(['CUSTOMER'], 'CUSTOMER');
  const driverUser = await actor(['MOVER', 'CUSTOMER'], 'MOVER');
  const driver = await sys(() => app.prisma.driver.create({ data: {
    userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', vehicleYear: 2015, licensePlate: `T ${nanoid(6)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
    currentLat: 6.8, currentLng: -58.15, lastLocationUpdate: new Date(),
  } as never }));
  driverIds.push(driver.id);
  const order = await sys(async () => {
    const created = await app.prisma.order.create({ data: {
      orderNumber: `TRP-${nanoid(10)}`, customerId: customer.id, orderType: 'TAXI', status: 'PENDING', pickupAddress: 'Pickup', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'Drop', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 800, subtotalMarkup: 0, subtotalCustomer: 800, deliveryFee: 0, totalAmount: 800, taxiFareTotal: 800, paymentMethod: 'CASH', ridePin: '123456',
    } as never });
    await walkOrderStatus(app.prisma, created.id, status, { driverId: driver.id, acceptedAt: new Date() });
    await app.prisma.order.update({ where: { id: created.id }, data: over });
    return app.prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  });
  orderIds.push(order.id);
  return { order, customer, driverUser, driverId: driver.id };
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, as: Actor, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${as.token}`, ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
const reset = async (id: string, as: Actor = admin) => {
  await grantStepUp(app, as.token);
  return call('POST', `/api/v1/admin/orders/${id}/handover-secret/reset-ride-pin`, as, { reason: REASON }, { 'x-swift-reason': REASON });
};
const row = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
  admin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.identityClusterMember.deleteMany({ where: { clusterId: { in: clusterIds } } });
    await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusterIds } } });
    await app.prisma.rating.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await purgeAuditLogs(app.prisma, { entityId: { in: orderIds } }, 'test-cleanup:ride-after-the-trip');
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  });
  await app.close();
});

describe('[G05] five wrong codes', () => {
  it('the driver is told support can help, and support can', async () => {
    const { order, customer, driverUser } = await ride('DRIVER_ARRIVED', { ridePinAttempts: 5 });
    const locked = await call('PUT', `/api/v1/driver/rides/${order.id}/verify-pin`, driverUser, { pin: '123456' });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.message).toContain('Ask Swift support for a new ride code');

    const res = await reset(order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('"ridePin"');
    const after = await row(order.id);
    expect(after.ridePinAttempts).toBe(0);
    expect(handoverCodeMatches(after.ridePin, '123456')).toBe(false);
    expect((await call('PUT', `/api/v1/driver/rides/${order.id}/verify-pin`, driverUser, { pin: after.ridePin })).statusCode).toBe(200);
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.id, data: { path: ['orderId'], equals: order.id } } }));
    expect(told.map((notice) => notice.title)).toEqual(['New ride code']);
    expect(told[0]!.body).not.toContain(after.ridePin);
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: order.id, action: 'RESET_RIDE_PIN' } }))).toBe(1);
  });

  it('asks for a step-up, as its sister doors do', async () => {
    const { order } = await ride('DRIVER_ARRIVED');
    const fresh = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const res = await call('POST', `/api/v1/admin/orders/${order.id}/handover-secret/reset-ride-pin`, fresh, { reason: REASON }, { 'x-swift-reason': REASON });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('nothing to reset once the passenger is aboard', async () => {
    const { order } = await ride('DRIVER_ARRIVED', { ridePinVerified: true, ridePinVerifiedAt: new Date() });
    const res = await reset(order.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RIDE_PIN_CLOSED');
    const inProgress = await ride('RIDE_IN_PROGRESS');
    expect((await reset(inProgress.order.id)).statusCode).toBe(409);
  });

  it('only a ride, and nobody resets a ride they are on', async () => {
    const mine = await ride('DRIVER_ARRIVED', {}, admin);
    const res = await reset(mine.order.id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OWN_RIDE');
    expect((await row(mine.order.id)).ridePin).toBe('123456');
  });
});

describe('[G05] who may reset a code, by what the database says', () => {
  /** A cluster holding these accounts; `review` flags it for a person. */
  const linked = (accounts: string[], review = false) => sys(async () => {
    const cluster = await app.prisma.identityCluster.create({ data: { authorityReviewRequired: review } });
    clusterIds.push(cluster.id);
    await app.prisma.identityClusterMember.createMany({ data: accounts.map((accountId) => ({ accountId, clusterId: cluster.id, linkedVia: [] })) });
  });
  const anotherAdmin = () => actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
  const boss = () => actor(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', true);

  it('a linked account counts as the person, on either side of the ride', async () => {
    const twin = await anotherAdmin();
    const asPassenger = await ride('DRIVER_ARRIVED');
    await linked([asPassenger.customer.id, twin.id]);
    const res = await reset(asPassenger.order.id, twin);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OWN_RIDE');
    expect((await row(asPassenger.order.id)).ridePin).toBe('123456');

    const driverTwin = await anotherAdmin();
    const asDriver = await ride('DRIVER_ARRIVED');
    await linked([asDriver.driverUser.id, driverTwin.id]);
    const second = await reset(asDriver.order.id, driverTwin);
    expect(second.statusCode, second.body).toBe(403);
    expect(second.json().error.code).toBe('OWN_RIDE');
  });

  it('an identity waiting for a person refuses: it cannot be known who is on this ride', async () => {
    const { order, customer } = await ride('DRIVER_ARRIVED');
    await linked([customer.id], true);
    const res = await reset(order.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
    expect((await row(order.id)).ridePin).toBe('123456');
  });

  it('so does an admin whose own identity is waiting for a person', async () => {
    const { order } = await ride('DRIVER_ARRIVED');
    const reviewed = await anotherAdmin();
    await linked([reviewed.id], true);
    const res = await reset(order.id, reviewed);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
  });

  it('a staff account on the ride, or linked to it: a plain admin is refused, a SUPER_ADMIN not on it resets', async () => {
    const staffRide = await ride('DRIVER_ARRIVED', {}, await anotherAdmin());
    const refused = await reset(staffRide.order.id);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('STAFF_ON_RIDE');
    expect((await reset(staffRide.order.id, await boss())).statusCode).toBe(200);

    const hidden = await anotherAdmin();
    const linkedRide = await ride('DRIVER_ARRIVED');
    await linked([linkedRide.driverUser.id, hidden.id]);
    const second = await reset(linkedRide.order.id);
    expect(second.statusCode, second.body).toBe(403);
    expect(second.json().error.code).toBe('STAFF_ON_RIDE');
  });
});

describe('[G06] a finished ride read back', () => {
  it('carries what the screen needs: driver, plate, what was paid, whether it was rated', async () => {
    const { order, customer, driverUser } = await ride('RIDE_IN_PROGRESS');
    await sys(() => walkOrderStatus(app.prisma, order.id, 'DELIVERED', { totalAmount: 1100 }));
    const res = await call('GET', `/api/v1/rides/${order.id}`, customer);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'DELIVERED', hasBeenRated: false, driver: { vehicleMake: 'Toyota' } });
    expect(Number(res.json().data.totalAmount)).toBe(1100);
    expect(Number(res.json().data.taxiFareTotal)).toBe(800);
    await sys(() => app.prisma.rating.create({ data: { orderId: order.id, raterId: customer.id, rateeId: driverUser.id, score: 5, type: 'CUSTOMER_TO_DRIVER' } as never }));
    expect((await call('GET', `/api/v1/rides/${order.id}`, customer)).json().data.hasBeenRated).toBe(true);
  });
});
