import { withSuiteCapability } from '../lib/test-target-lock';
import { advanceDriverPickup, drainDriverPickupNotices } from '../modules/rides/driver-pickup';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { driverRoutes } from '../modules/driver/driver.routes';
import { NotificationService } from '../modules/notification/notification.service';

// Real routes and PostgreSQL; authentication, sockets and push are synthetic.
let app: FastifyInstance;
const users: string[] = [];
const orders: string[] = [];
const emit = vi.fn();
const notices = vi.fn();
let seq = 0;
const pickup = { lat: 3.38, lng: -59.79 };
beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  app.decorate('io', { to: () => ({ emit }), emit } as never);
  app.decorate('redis', {} as never);
  app.decorate('authenticate', async (request) => { request.user = { userId: String(request.headers['test-actor']), role: 'DRIVER' }; });
  await app.register(driverRoutes, { prefix: '/driver' });
  await app.ready();
});
afterEach(() => { vi.restoreAllMocks(); emit.mockClear(); notices.mockClear(); });
afterAll(async () => {
  if (!app) return;
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orders } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});
async function actor(driver: boolean) {
  const user = await app.prisma.user.create({ data: {
    phone: `+5920787${String(++seq).padStart(4, '0')}`, firstName: 'Synthetic', lastName: 'Pickup',
    roles: [driver ? 'DRIVER' : 'CUSTOMER'], activeRole: driver ? 'DRIVER' : 'CUSTOMER',
    ...(driver ? { driver: { create: {
      vehicleMake: 'Toyota', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `L07-${seq}`, driverLicenseUrl: 'synthetic', vehicleInsuranceUrl: 'synthetic',
      currentLat: pickup.lat, currentLng: pickup.lng, lastLocationUpdate: new Date(),
    } } } : { customer: { create: {} } }),
  }, include: { driver: true } });
  users.push(user.id);
  return user;
}
async function fixture(endpoint: 'en-route' | 'arrived') {
  vi.spyOn(NotificationService.prototype, 'send').mockImplementation(notices);
  const mover = await actor(true);
  const customer = await actor(false);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `L07-T-${nanoid(12)}`, customerId: customer.id, driverId: mover.driver!.id,
    orderType: 'TAXI', status: endpoint === 'arrived' ? 'DRIVER_EN_ROUTE' : 'DRIVER_ASSIGNED',
    pickupAddress: 'Synthetic pickup', pickupLat: pickup.lat, pickupLng: pickup.lng,
    deliveryAddress: 'Synthetic destination', deliveryLat: 3.39, deliveryLng: -59.78,
    subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0, totalAmount: 0,
    paymentMethod: 'CASH', acceptedAt: new Date(),
  } });
  orders.push(order.id);
  return { mover, order };
}
function pauseOwnershipRead() {
  let entered!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const original = app.prisma.order.findFirst.bind(app.prisma.order);
  vi.spyOn(app.prisma.order, 'findFirst').mockImplementationOnce((args) => (async () => {
    const snapshot = await original(args);
    entered(); await gate;
    return snapshot;
  })() as ReturnType<typeof original>);
  return { waiting, resume };
}

describe('driver pickup authority survives no assignment change', () => {
  it('requires the assigned actor even when the submitted generation is current', async () => {
    const { order } = await fixture('en-route');
    const stranger = await actor(true);
    await expect(advanceDriverPickup(app.prisma, {
      orderId: order.id, driverId: stranger.driver!.id, assignmentVersion: order.driverAssignmentVersion,
      changedBy: stranger.id, from: 'DRIVER_ASSIGNED', target: 'DRIVER_EN_ROUTE', note: 'Synthetic attempt',
    })).rejects.toMatchObject({ code: 'ACTOR_NOT_ASSIGNED' });
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
  });
  it('advances the database generation through release and reassignment and rejects rewrites', async () => {
    const { mover, order } = await fixture('en-route');
    const released = await app.prisma.order.update({ where: { id: order.id }, data: { driverId: null, driverAssignmentVersion: 0 } });
    expect(released.driverAssignmentVersion).toBe(order.driverAssignmentVersion + 1);
    const assigned = await app.prisma.order.update({ where: { id: order.id }, data: { driverId: mover.driver!.id } });
    expect(assigned.driverAssignmentVersion).toBe(order.driverAssignmentVersion + 2);
    const rewritten = await app.prisma.order.update({ where: { id: order.id }, data: { driverAssignmentVersion: 0 } });
    expect(rewritten.driverAssignmentVersion).toBe(assigned.driverAssignmentVersion);
  });
  for (const endpoint of ['en-route', 'arrived'] as const) {
    it.each(['replacement', 'same-driver-again'] as const)(`${endpoint} refuses %s after the ownership read`, async (replacement) => {
      const { mover, order } = await fixture(endpoint);
      const next = replacement === 'replacement' ? await actor(true) : mover;
      const pause = pauseOwnershipRead();
      const pending = app.inject({ method: 'PUT', url: `/driver/rides/${order.id}/${endpoint}`, headers: { 'test-actor': mover.id } }).then((r) => r);
      await pause.waiting;
      try {
        await app.prisma.order.update({ where: { id: order.id }, data: { driverId: null, status: 'PENDING', acceptedAt: null } });
        await app.prisma.order.update({ where: { id: order.id }, data: { driverId: next.driver!.id, status: order.status, acceptedAt: new Date() } });
      } finally { pause.resume(); }
      const response = await pending;
      expect(response.statusCode, response.body).toBe(409);
      expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: order.status, driverId: next.driver!.id, driverArrivedAt: null });
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
      expect(emit).not.toHaveBeenCalled();
      expect(notices).not.toHaveBeenCalled();
    });
    it(`${endpoint} commits one history record when two requests share the ownership preview`, async () => {
      const { mover, order } = await fixture(endpoint);
      const pause = pauseOwnershipRead();
      const input = { method: 'PUT' as const, url: `/driver/rides/${order.id}/${endpoint}`, headers: { 'test-actor': mover.id } };
      const pending = app.inject(input).then((r) => r);
      await pause.waiting;
      let winner;
      try { winner = await app.inject(input); } finally { pause.resume(); }
      expect(winner.statusCode, winner.body).toBe(200);
      const loser = await pending;
      expect(loser.statusCode, loser.body).toBe(409);
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(1);
    });
    it(`${endpoint} rolls the pickup fact back if the database refuses its history`, async () => {
      const { mover, order } = await fixture(endpoint);
      expect(order.id).toMatch(/^[a-z0-9]+$/);
      // Real database fault, confined to this one synthetic order. The state
      // write must roll back with its failed immutable history insert.
      await withSuiteCapability('ddl', async () => {
        await app.prisma.$executeRawUnsafe(`CREATE FUNCTION l07_driver_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW."orderId" = '${order.id}' THEN RAISE EXCEPTION 'synthetic history failure'; END IF; RETURN NEW; END; $$`);
        await app.prisma.$executeRawUnsafe('CREATE TRIGGER l07_driver_history_failure BEFORE INSERT ON order_status_logs FOR EACH ROW EXECUTE FUNCTION l07_driver_history_failure()');
      });
      try {
        const response = await app.inject({ method: 'PUT', url: `/driver/rides/${order.id}/${endpoint}`, headers: { 'test-actor': mover.id } });
        expect(response.statusCode).toBe(500);
        expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: order.status, driverArrivedAt: null });
        expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
        expect(await app.prisma.orderOutbox.count({ where: { orderId: order.id } })).toBe(0);
      } finally {
        await withSuiteCapability('ddl', async () => {
          await app.prisma.$executeRawUnsafe('DROP TRIGGER l07_driver_history_failure ON order_status_logs');
          await app.prisma.$executeRawUnsafe('DROP FUNCTION l07_driver_history_failure()');
        });
      }
    });
    it(`${endpoint} returns its committed result after push failure and retries the durable notice`, async () => {
      const { mover, order } = await fixture(endpoint);
      vi.spyOn(NotificationService.prototype, 'publishPersisted').mockRejectedValue(new Error('synthetic publication outage'));
      const response = await app.inject({ method: 'PUT', url: `/driver/rides/${order.id}/${endpoint}`, headers: { 'test-actor': mover.id } });
      expect(response.statusCode, response.body).toBe(200);
      const row = await app.prisma.orderOutbox.findFirstOrThrow({ where: { orderId: order.id, kind: 'driver-pickup-notice' } });
      expect(row.processedAt).toBeNull();
      const publishPersisted = vi.fn(async () => true);
      expect(await drainDriverPickupNotices({ prisma: app.prisma, notifications: { publishPersisted }, now: () => new Date(Date.now() + 600_000) }, { orderId: order.id }))
        .toEqual({ delivered: 1, pending: 0, obsolete: 0 });
      expect(publishPersisted).toHaveBeenCalledTimes(1);
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(1);
      expect(await app.prisma.notification.count({ where: { dedupeKey: row.dedupeKey } })).toBe(1);
    });
    it(`${endpoint} keeps the existing client response and hides the ride PIN`, async () => {
      const { mover, order } = await fixture(endpoint);
      const response = await app.inject({ method: 'PUT', url: `/driver/rides/${order.id}/${endpoint}`, headers: { 'test-actor': mover.id } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({ id: order.id, driverId: mover.driver!.id, status: endpoint === 'arrived' ? 'DRIVER_ARRIVED' : 'DRIVER_EN_ROUTE' });
      expect(response.json().data).not.toHaveProperty('ridePin');
      if (endpoint === 'arrived') expect(response.json().data.driverArrivedAt).toEqual(expect.any(String));
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(1);
    });
  }
});
