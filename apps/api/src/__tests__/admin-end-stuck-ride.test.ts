import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { AccountService } from '../modules/user/account.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ACTIVE_TAXI_STATUSES } from '../modules/rides/rides.service';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone } from './helpers/fixture-ids';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// A taxi ride in progress has two exits, DELIVERED and FAILED, and both are the driver's own handover. With the driver
// gone, nobody could close it: the passenger could not book or delete, and suspend and ban on that driver refused. Support
// now ends it from the order, with a reason and an audit row. Both sides are told. No fare is invented: nothing about money
// changes, because nothing about money is known.

const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, 'x');
const DAY = 86_400_000;
let app: FastifyInstance;
let admin: { id: string; token: string };
const userIds: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];

async function user(roles: string[] = ['CUSTOMER'], extra: Record<string, unknown> = {}) {
  const row = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Ride', lastName: `E${RUN}`, roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true, ...extra } as never });
  userIds.push(row.id);
  return row.id;
}

async function staff(permissions: string[]) {
  const id = await user(['ADMIN', 'CUSTOMER'], { status: 'ACTIVE', admin: { create: { permissions } } });
  const token = app.jwt.sign({ userId: id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `ride-${nanoid(4)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { id, token };
}

async function ride(status: 'RIDE_IN_PROGRESS' | 'DRIVER_ARRIVED' | 'DRIVER_ASSIGNED' = 'RIDE_IN_PROGRESS', pin: { ridePinVerified?: boolean; ridePinVerifiedAt?: Date } = {}) {
  const customerId = await user();
  const driverUser = await user(['MOVER', 'CUSTOMER']);
  const driver = await app.prisma.driver.create({ data: {
    userId: driverUser, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', vehicleYear: 2015, licensePlate: `END ${nanoid(4)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } as never });
  driverIds.push(driver.id);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `ER-${nanoid(10).toUpperCase()}`, customerId, orderType: 'TAXI', status: 'PENDING', deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
  } as never });
  orderIds.push(order.id);
  await walkOrderStatus(app.prisma, order.id, status, { driverId: driver.id });
  await app.prisma.driver.update({ where: { id: driver.id }, data: { currentRideId: order.id } });
  if (Object.keys(pin).length > 0) await app.prisma.order.update({ where: { id: order.id }, data: pin });
  return { orderId: order.id, customerId, driverUser, driverId: driver.id };
}

const end = (orderId: string, token = admin.token, reason: string | null = TEST_ADMIN_REASON) => app.inject({
  method: 'POST', url: `/api/v1/admin/orders/${orderId}/end-ride`,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: reason ? { reason } : {},
});
const inbox = async (userId: string) => (await app.prisma.notification.findMany({ where: { userId } })).filter((row) => (row.data as { orderId?: string } | null)?.orderId);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  admin = await staff(['*']);
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.close();
});

describe('support ends a ride whose driver is gone', () => {
  it('is a consequential act: a reason, on a capability of its own', () => {
    expect(ADMIN_ROUTE_AUTHORITY['POST /orders/:id/end-ride']).toMatchObject({ cls: 'C3', capability: 'order.ride.end' });
  });

  it('closes it with what is known: no fare, no earning, no strike, no claim, and the driver is free', async () => {
    const r = await ride();
    const res = await end(r.orderId);
    expect(res.statusCode, res.payload).toBe(200);

    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: r.orderId } });
    expect(order).toMatchObject({ status: 'FAILED', paymentStatus: 'PENDING' });
    expect(Number(order.totalAmount)).toBe(1500);
    expect(await app.prisma.reimbursementClaim.count({ where: { orderId: r.orderId } })).toBe(0);
    expect(await app.prisma.strike.count({ where: { userId: { in: [r.customerId, r.driverUser] } } })).toBe(0);
    expect(await app.prisma.driver.findUniqueOrThrow({ where: { id: r.driverId } })).toMatchObject({ currentRideId: null });
    expect(await app.prisma.earning.count({ where: { orderId: r.orderId } })).toBe(0);
  });

  it('tells both sides plainly, and promises nothing about money', async () => {
    const r = await ride();
    const published = vi.spyOn(NotificationService.prototype, 'publishPersisted');
    const rooms = vi.spyOn(app.io, 'in');
    await end(r.orderId);
    expect(published).toHaveBeenCalledTimes(2);
    expect(rooms).toHaveBeenCalledWith(`order:${r.orderId}`);
    published.mockRestore();
    rooms.mockRestore();
    for (const who of [r.customerId, r.driverUser]) {
      const [notice] = await inbox(who);
      expect(notice).toMatchObject({ title: 'Ride closed by Swift' });
      expect(notice!.body).toContain('Swift has no record of what was paid, and moved no money.');
    }
    expect((await inbox(r.customerId))[0]!.body).toContain('If you paid the driver');
    expect((await inbox(r.customerId))[0]!.data).toMatchObject({ audience: 'customer', status: 'FAILED', orderType: 'TAXI' });
    expect((await inbox(r.driverUser))[0]!.data).toMatchObject({ audience: 'earner', status: 'FAILED', orderType: 'TAXI' });
  });

  it('leaves the record: who, why, from where', async () => {
    const r = await ride();
    await end(r.orderId);
    const row = await app.prisma.auditLog.findFirst({ where: { userId: admin.id, action: 'END_STUCK_RIDE', entityId: r.orderId } });
    expect(row!.changes).toMatchObject({ reason: TEST_ADMIN_REASON, previousStatus: 'RIDE_IN_PROGRESS' });
    expect(await app.prisma.orderStatusLog.findFirst({ where: { orderId: r.orderId, status: 'FAILED' } })).toMatchObject({ changedBy: admin.id });
  });

  it('then nobody is stuck: the passenger can delete, and the driver can be suspended', async () => {
    const r = await ride();
    const liveRides = () => app.prisma.order.count({ where: { customerId: r.customerId, status: { in: [...ACTIVE_TAXI_STATUSES] } } });
    expect(await liveRides()).toBe(1);
    await expect(new AccountService(app).deleteAccount(r.customerId, true)).rejects.toMatchObject({ code: 'ACTIVE_ORDERS' });
    const suspend = (token: string) => app.inject({ method: 'PUT', url: `/api/v1/admin/users/${r.driverUser}/suspend`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { reason: TEST_ADMIN_REASON } });
    expect((await suspend(admin.token)).statusCode).toBe(409);

    expect((await end(r.orderId)).statusCode).toBe(200);
    expect(await liveRides()).toBe(0);
    await expect(new AccountService(app).deleteAccount(r.customerId, true)).resolves.toBeDefined();
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: r.customerId } })).toMatchObject({ status: 'DEACTIVATED' });
    expect((await suspend(admin.token)).statusCode).toBe(200);
  });

  it('and the driver can be banned', async () => {
    const r = await ride();
    const ban = () => app.inject({ method: 'PUT', url: `/api/v1/admin/users/${r.driverUser}/ban`, headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, payload: { reason: TEST_ADMIN_REASON } });
    expect((await ban()).statusCode).toBe(409);
    expect((await end(r.orderId)).statusCode).toBe(200);
    expect((await ban()).statusCode).toBe(200);
  });

  it('the passenger is in the car and the driver never tapped Start: the same door, one commit', async () => {
    const r = await ride('DRIVER_ARRIVED', { ridePinVerified: true, ridePinVerifiedAt: new Date() });
    const res = await end(r.orderId);
    expect(res.statusCode, res.payload).toBe(200);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ status: 'FAILED', paymentStatus: 'PENDING' });
    const trail = await app.prisma.orderStatusLog.findMany({ where: { orderId: r.orderId, status: { in: ['RIDE_IN_PROGRESS', 'FAILED'] } }, orderBy: { createdAt: 'asc' } });
    expect(trail.slice(-2).map((row) => [row.status, row.note])).toEqual([
      ['RIDE_IN_PROGRESS', 'Passenger code verified: the driver never started the trip'],
      ['FAILED', 'Closed by Swift support: no payment on record'],
    ]);
    expect(await app.prisma.driver.findUniqueOrThrow({ where: { id: r.driverId } })).toMatchObject({ currentRideId: null });
    expect(await app.prisma.auditLog.count({ where: { action: 'END_STUCK_RIDE', entityId: r.orderId } })).toBe(1);
    expect(await inbox(r.customerId)).toHaveLength(1);
    expect(await inbox(r.driverUser)).toHaveLength(1);
  });

  it('the older record of a verified code is the same custody', async () => {
    const r = await ride('DRIVER_ARRIVED', { ridePinVerifiedAt: new Date() });
    expect((await end(r.orderId)).statusCode).toBe(200);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ status: 'FAILED' });
  });

  it.each(['DRIVER_ASSIGNED', 'DRIVER_ARRIVED'] as const)('a ride not in progress is not this door: at %s with no code, cancel does it', async (status) => {
    const r = await ride(status);
    const res = await end(r.orderId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RIDE_NOT_IN_PROGRESS');
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ status });
  });

  it('a ride already closed says so, and nothing is told twice', async () => {
    const r = await ride();
    await end(r.orderId);
    expect((await end(r.orderId)).statusCode).toBe(409);
    expect(await inbox(r.customerId)).toHaveLength(1);
  });

  it('only a ride', async () => {
    const r = await ride();
    await app.prisma.order.update({ where: { id: r.orderId }, data: { orderType: 'FOOD_DELIVERY' } });
    expect((await end(r.orderId)).statusCode).toBe(409);
  });

  it('a live SOS on the ride comes first', async () => {
    const r = await ride();
    await app.prisma.sosAlert.create({ data: { actorUserId: r.customerId, actorRole: 'CUSTOMER', orderId: r.orderId, status: 'ACTIVE' } });
    const res = await end(r.orderId);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('SOS_LIVE');
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ status: 'RIDE_IN_PROGRESS' });
    expect(await inbox(r.customerId)).toHaveLength(0);
    expect(await app.prisma.auditLog.count({ where: { action: 'END_STUCK_RIDE', entityId: r.orderId } })).toBe(0);
  });

  it('a resolved SOS does not hold the ride', async () => {
    const r = await ride();
    await app.prisma.sosAlert.create({ data: { actorUserId: r.customerId, actorRole: 'CUSTOMER', orderId: r.orderId, status: 'RESOLVED' } });
    expect((await end(r.orderId)).statusCode).toBe(200);
  });

  it('no reason, nothing happens', async () => {
    const r = await ride();
    expect((await end(r.orderId, admin.token, null)).statusCode).toBe(400);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ status: 'RIDE_IN_PROGRESS' });
  });

  it('a grant without the capability is refused', async () => {
    const r = await ride();
    const support = await staff(['order.read']);
    expect((await end(r.orderId, support.token)).statusCode).toBe(403);
  });
});
