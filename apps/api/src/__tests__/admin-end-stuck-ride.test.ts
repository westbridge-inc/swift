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
import { assertClearOfParties } from '../modules/integrity/party-authority';
import { AppError } from '../utils/errors';
import { OrderService } from '../modules/order/order.service';
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

async function staff(permissions: string[], role: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN') {
  const id = await user([role, 'CUSTOMER'], { status: 'ACTIVE', admin: { create: { permissions } } });
  const token = app.jwt.sign({ userId: id, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `ride-${nanoid(4)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { id, token };
}

async function ride(status: 'RIDE_IN_PROGRESS' | 'DRIVER_ARRIVED' | 'DRIVER_ASSIGNED' = 'RIDE_IN_PROGRESS', pin: { ridePinVerified?: boolean; ridePinVerifiedAt?: Date } = {}, on: { passenger?: string; driver?: string } = {}) {
  const customerId = on.passenger ?? await user();
  const driverUser = on.driver ?? await user(['MOVER', 'CUSTOMER']);
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

  // [COORD ruling on REVIEW-M9's 11:21Z] Nobody ends a ride they are on. A ride with staff on it goes to a SUPER_ADMIN who is
  // not on it, so nothing stays stuck. Every test here is the real route, and a refusal leaves no trace at all.
  const refused = async (orderId: string, token: string, code: string, status = 'RIDE_IN_PROGRESS') => {
    const res = await end(orderId, token);
    expect(res.statusCode, res.payload).toBe(403);
    expect(res.json().error.code).toBe(code);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status });
    expect(await app.prisma.auditLog.count({ where: { action: 'END_STUCK_RIDE', entityId: orderId } })).toBe(0);
    expect(await app.prisma.notification.count({ where: { title: 'Ride closed by Swift', data: { path: ['orderId'], equals: orderId } } })).toBe(0);
  };

  it('nobody ends a ride they are the passenger of', async () => {
    const me = await staff(['*']);
    await refused((await ride('RIDE_IN_PROGRESS', {}, { passenger: me.id })).orderId, me.token, 'OWN_RIDE');
  });

  it('nobody ends a ride they are the driver of, on the narrowest grant', async () => {
    const me = await staff(['order.ride.end']);
    await refused((await ride('RIDE_IN_PROGRESS', {}, { driver: me.id })).orderId, me.token, 'OWN_RIDE');
  });

  it('not a SUPER_ADMIN either, and not from the verified-code state', async () => {
    const owner = () => staff(['*'], 'SUPER_ADMIN');
    const passenger = await owner();
    await refused((await ride('RIDE_IN_PROGRESS', {}, { passenger: passenger.id })).orderId, passenger.token, 'OWN_RIDE');
    const driver = await owner();
    await refused((await ride('RIDE_IN_PROGRESS', {}, { driver: driver.id })).orderId, driver.token, 'OWN_RIDE');
    const boarded = await owner();
    await refused((await ride('DRIVER_ARRIVED', { ridePinVerified: true }, { passenger: boarded.id })).orderId, boarded.token, 'OWN_RIDE', 'DRIVER_ARRIVED');
  });

  it('nor through an account linked to the same person', async () => {
    const me = await staff(['*'], 'SUPER_ADMIN');
    const r = await ride();
    for (const party of [r.customerId, r.driverUser]) {
      const cluster = await app.prisma.identityCluster.create({ data: {} });
      await app.prisma.identityClusterMember.createMany({ data: [
        { accountId: party, clusterId: cluster.id, linkedVia: [] }, { accountId: me.id, clusterId: cluster.id, linkedVia: [] },
      ] });
      try {
        await refused(r.orderId, me.token, 'OWN_RIDE');
      } finally {
        await app.prisma.identityClusterMember.deleteMany({ where: { clusterId: cluster.id } });
        await app.prisma.identityCluster.delete({ where: { id: cluster.id } });
      }
    }
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)('a ride with a %s on it is out of an ADMIN\'s reach, on either side, and a SUPER_ADMIN not on it ends it', async (role) => {
    const onRide = await staff(['*'], role);
    const owner = await staff(['*'], 'SUPER_ADMIN');
    const asPassenger = await ride('RIDE_IN_PROGRESS', {}, { passenger: onRide.id });
    await refused(asPassenger.orderId, admin.token, 'STAFF_ON_RIDE');
    expect((await end(asPassenger.orderId, owner.token)).statusCode).toBe(200);
    const asDriver = await ride('RIDE_IN_PROGRESS', {}, { driver: onRide.id });
    await refused(asDriver.orderId, admin.token, 'STAFF_ON_RIDE');
    expect((await end(asDriver.orderId, owner.token)).statusCode).toBe(200);
  });

  /** Runs `change` after the route's guard and before the order's lock: what the close reads is what the database says then. */
  const beforeTheLock = (change: () => Promise<unknown>) => {
    const real = OrderService.prototype.stageCanonicalOrderTransition;
    return vi.spyOn(OrderService.prototype, 'stageCanonicalOrderTransition').mockImplementationOnce(async function stage(this: OrderService, tx, input) {
      await change();
      return real.call(this, tx, input);
    });
  };

  it('made staff while the request was on its way: the roles are the database\'s, under the lock', async () => {
    const r = await ride();
    const spy = beforeTheLock(() => app.prisma.user.update({ where: { id: r.customerId }, data: { roles: ['ADMIN', 'CUSTOMER'] } }));
    await refused(r.orderId, admin.token, 'STAFF_ON_RIDE');
    spy.mockRestore();
  });

  it('a SUPER_ADMIN stood down while the request was on its way is an ADMIN at the close', async () => {
    const owner = await staff(['*'], 'SUPER_ADMIN');
    const onRide = await staff(['*']);
    const r = await ride('RIDE_IN_PROGRESS', {}, { passenger: onRide.id });
    const spy = beforeTheLock(() => app.prisma.user.update({ where: { id: owner.id }, data: { roles: ['ADMIN', 'CUSTOMER'] } }));
    await refused(r.orderId, owner.token, 'STAFF_ON_RIDE');
    spy.mockRestore();
  });

  it('a plain ride stays with any ADMIN holding the grant', async () => {
    const narrow = await staff(['order.ride.end']);
    expect((await end((await ride()).orderId, narrow.token)).statusCode).toBe(200);
  });

  // [COORD follow-up] One rule with the refund rail: who is linked is the whole person, and an identity under review says
  // nobody can tell who is linked.
  const linked = async (accounts: string[], review = false) => {
    const cluster = await app.prisma.identityCluster.create({ data: { authorityReviewRequired: review } });
    await app.prisma.identityClusterMember.createMany({ data: accounts.map((accountId) => ({ accountId, clusterId: cluster.id, linkedVia: [] })) });
    return async () => {
      await app.prisma.identityClusterMember.deleteMany({ where: { clusterId: cluster.id } });
      await app.prisma.identityCluster.delete({ where: { id: cluster.id } });
    };
  };

  // [COORD ruling on REVIEW-G11's note] Nobody is stuck: a review must not hold a ride open for ever. For ride end only, a
  // SUPER_ADMIN who is not on the ride ends it, and the audit row says the review was open.
  const closedRow = (orderId: string) => app.prisma.auditLog.findFirst({ where: { action: 'END_STUCK_RIDE', entityId: orderId } });

  it.each(['passenger', 'driver'] as const)('an identity under review on the %s side: an ADMIN is refused, and a SUPER_ADMIN not on the ride ends it, on the record', async (side) => {
    const owner = await staff(['*'], 'SUPER_ADMIN');
    const r = await ride();
    const undo = await linked([side === 'passenger' ? r.customerId : r.driverUser], true);
    try {
      const res = await end(r.orderId);
      expect(res.statusCode, res.payload).toBe(409);
      expect(res.json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
      expect(await app.prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ status: 'RIDE_IN_PROGRESS' });
      expect(await closedRow(r.orderId)).toBeNull();

      expect((await end(r.orderId, owner.token)).statusCode).toBe(200);
      expect((await closedRow(r.orderId))!.changes).toMatchObject({ reason: TEST_ADMIN_REASON, previousStatus: 'RIDE_IN_PROGRESS', identityUnderReview: true });
    } finally {
      await undo();
    }
  });

  it('with no review open the record says nothing of one', async () => {
    const r = await ride();
    await end(r.orderId);
    expect((await closedRow(r.orderId))!.changes).not.toHaveProperty('identityUnderReview');
  });

  it('a review opens no door to your own ride: a SUPER_ADMIN on it, or listed as linked to it, is refused', async () => {
    const onIt = await staff(['*'], 'SUPER_ADMIN');
    const own = await ride('RIDE_IN_PROGRESS', {}, { passenger: onIt.id });
    const undoOwn = await linked([onIt.id], true);
    const listed = await staff(['*'], 'SUPER_ADMIN');
    const other = await ride();
    const undoListed = await linked([other.customerId, listed.id], true);
    try {
      await refused(own.orderId, onIt.token, 'OWN_RIDE');
      await refused(other.orderId, listed.token, 'OWN_RIDE');
    } finally {
      await undoOwn();
      await undoListed();
    }
  });

  it('the shared rule stays closed for every other door: a review refuses a SUPER_ADMIN there', async () => {
    const owner = await staff(['*'], 'SUPER_ADMIN');
    const r = await ride();
    const undo = await linked([r.customerId], true);
    const words = { own: new AppError(403, 'OWN', 'x'), staff: new AppError(403, 'STAFF', 'x') };
    try {
      await expect(app.prisma.$transaction((tx) => assertClearOfParties(tx, owner.id, [r.customerId], words))).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
    } finally {
      await undo();
    }
  });

  it('a ride with the verified code and no Start records where it was, under review or not', async () => {
    const r = await ride('DRIVER_ARRIVED', { ridePinVerified: true, ridePinVerifiedAt: new Date() });
    await end(r.orderId);
    expect((await closedRow(r.orderId))!.changes).toMatchObject({ reason: TEST_ADMIN_REASON, previousStatus: 'DRIVER_ARRIVED' });
  });

  it.each(['passenger', 'driver'] as const)('a staff account linked to the %s is staff on the ride: a SUPER_ADMIN not on it ends it', async (side) => {
    const colleague = await staff(['*']);
    const owner = await staff(['*'], 'SUPER_ADMIN');
    const r = await ride();
    const undo = await linked([side === 'passenger' ? r.customerId : r.driverUser, colleague.id]);
    try {
      await refused(r.orderId, admin.token, 'STAFF_ON_RIDE');
      expect((await end(r.orderId, owner.token)).statusCode).toBe(200);
    } finally {
      await undo();
    }
  });

  const online = (driverId: string) => app.prisma.driver.update({ where: { id: driverId }, data: { isOnline: true, isAvailable: true, locationSessionId: `loc-${nanoid(6)}` } });
  const OFFLINE = { isOnline: false, isAvailable: false, locationSessionId: null, currentRideId: null };

  it('a gone driver comes out of the close offline, not available, and is told', async () => {
    const r = await ride();
    await online(r.driverId);
    expect((await end(r.orderId)).statusCode).toBe(200);
    expect(await app.prisma.driver.findUniqueOrThrow({ where: { id: r.driverId } })).toMatchObject(OFFLINE);
    expect((await inbox(r.driverUser))[0]!.body).toContain('You are offline until you go online again.');
    expect((await inbox(r.customerId))[0]!.body).not.toContain('offline');
  });

  it('the same from a verified code with no Start', async () => {
    const r = await ride('DRIVER_ARRIVED', { ridePinVerified: true, ridePinVerifiedAt: new Date() });
    await online(r.driverId);
    expect((await end(r.orderId)).statusCode).toBe(200);
    expect(await app.prisma.driver.findUniqueOrThrow({ where: { id: r.driverId } })).toMatchObject(OFFLINE);
    expect(await app.prisma.auditLog.count({ where: { action: 'END_STUCK_RIDE', entityId: r.orderId } })).toBe(1);
    expect(await inbox(r.driverUser)).toHaveLength(1);
  });

  it('a driver the ride no longer holds, already on another, stays online', async () => {
    const r = await ride();
    const other = await ride();
    await online(r.driverId);
    await app.prisma.driver.update({ where: { id: r.driverId }, data: { currentRideId: other.orderId } });
    expect((await end(r.orderId)).statusCode).toBe(200);
    expect(await app.prisma.driver.findUniqueOrThrow({ where: { id: r.driverId } })).toMatchObject({ isOnline: true, currentRideId: other.orderId });
  });
});
