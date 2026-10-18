import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { reopenPreCustodyLeg } from '../modules/dispatch/delivery-watchdog';
import { lockTaxiOrderForCustodyDecision } from '../modules/rides/passenger-custody';

// Real HTTP routes and PostgreSQL transitions. Authentication is supplied by
// the harness; sockets, push and Redis are recorded, with no provider calls.
let app: FastifyInstance;
const users: string[] = [];
const orders: string[] = [];
const emit = vi.fn();
const notices = vi.fn();
let seq = 0;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  app.decorate('io', { to: () => ({ emit }), emit } as never);
  app.decorate('redis', { get: vi.fn(async () => null), sadd: vi.fn(async () => 1), expire: vi.fn(async () => 1) } as never);
  app.decorate('authenticate', async (request) => {
    request.user = { userId: String(request.headers['test-actor']), role: 'RIDER' };
  });
  await app.register(riderRoutes, { prefix: '/rider' });
  await app.ready();
});
afterEach(() => { vi.restoreAllMocks(); emit.mockClear(); notices.mockClear(); });
afterAll(async () => {
  if (!app) return;
  await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});
async function actor(rider: boolean) {
  const user = await app.prisma.user.create({ data: {
    phone: `+5920789${String(++seq).padStart(4, '0')}`, firstName: 'Fixture', lastName: 'Pickup',
    roles: [rider ? 'RIDER' : 'CUSTOMER'], activeRole: rider ? 'RIDER' : 'CUSTOMER',
    ...(rider ? { rider: { create: { riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } } }
      : { customer: { create: {} } }),
  }, include: { rider: true } });
  users.push(user.id);
  return user;
}
async function fixture() {
  vi.spyOn(NotificationService.prototype, 'send').mockImplementation(notices);
  const mover = await actor(true);
  const customer = await actor(false);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `L07-${nanoid(12)}`, customerId: customer.id, riderId: mover.rider!.id,
    orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', status: 'RIDER_ARRIVED_PICKUP',
    pickupAddress: 'Synthetic pickup', pickupLat: 3.38, pickupLng: -59.79,
    deliveryAddress: 'Synthetic drop', deliveryLat: 3.39, deliveryLng: -59.78,
    subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0, totalAmount: 0,
    paymentMethod: 'CASH', readyAt: new Date(),
  } });
  orders.push(order.id);
  return { mover, order };
}
function request(id: string, userId: string) {
  return app.inject({ method: 'PUT', url: `/rider/orders/${id}/picked-up`, headers: { 'test-actor': userId } });
}
async function release(id: string, userId: string) {
  await app.prisma.$transaction(async (tx) => {
    await lockTaxiOrderForCustodyDecision(tx, id);
    const current = await tx.order.findUniqueOrThrow({ where: { id } });
    await reopenPreCustodyLeg(tx, current, userId, 'Synthetic handback');
  });
}
function pauseTransition() {
  let entered!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const original = OrderService.prototype.updateStatus;
  vi.spyOn(OrderService.prototype, 'updateStatus').mockImplementationOnce(async function (this: OrderService, ...args) {
    entered(); await gate;
    return original.apply(this, args);
  });
  return { waiting, resume };
}

describe('rider pickup binds the locked assignment and route state', () => {
  it('a handback committed after the ownership read refuses stale pickup without publication', async () => {
    const { mover, order } = await fixture();
    const pause = pauseTransition();
    const pending = request(order.id, mover.id).then((r) => r);
    await pause.waiting;
    try { await release(order.id, mover.id); } finally { pause.resume(); }
    const response = await pending;
    expect(response.statusCode, response.body).toBe(409);
    const current = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(current).toMatchObject({ status: 'READY_FOR_PICKUP', riderId: null, pickedUpAt: null });
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'PICKED_UP' } })).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });
  it('a different rider assigned while pickup waits keeps their assignment untouched', async () => {
    const { mover, order } = await fixture();
    const replacement = await actor(true);
    const pause = pauseTransition();
    const pending = request(order.id, mover.id).then((r) => r);
    await pause.waiting;
    try {
      await release(order.id, mover.id);
      await app.prisma.order.update({ where: { id: order.id }, data: { riderId: replacement.rider!.id, status: 'RIDER_ARRIVED_PICKUP' } });
    } finally { pause.resume(); }
    const response = await pending;
    expect(response.statusCode, response.body).toBe(409);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'RIDER_ARRIVED_PICKUP', riderId: replacement.rider!.id, pickedUpAt: null });
    expect(emit).not.toHaveBeenCalled();
  });
  it('a released rider assigned again cannot spend the previous assignment authority', async () => {
    const { mover, order } = await fixture();
    const pause = pauseTransition();
    const pending = request(order.id, mover.id).then((r) => r);
    await pause.waiting;
    try {
      await release(order.id, mover.id);
      await app.prisma.order.update({ where: { id: order.id }, data: { riderId: mover.rider!.id, status: 'RIDER_ARRIVED_PICKUP' } });
    } finally { pause.resume(); }
    const response = await pending;
    expect(response.statusCode, response.body).toBe(409);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'RIDER_ARRIVED_PICKUP', riderId: mover.rider!.id, pickedUpAt: null });
    expect(emit).not.toHaveBeenCalled();
  });
  it('a route-invalid state cannot borrow the broader global transition rule', async () => {
    const { mover, order } = await fixture();
    const pause = pauseTransition();
    const pending = request(order.id, mover.id).then((r) => r);
    await pause.waiting;
    try { await app.prisma.order.update({ where: { id: order.id }, data: { status: 'RIDER_ASSIGNED' } }); }
    finally { pause.resume(); }
    const response = await pending;
    expect(response.statusCode, response.body).toBe(409);
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'RIDER_ASSIGNED', pickedUpAt: null });
  });
  it('a legitimate pickup wins once and a later handback cannot erase custody', async () => {
    const { mover, order } = await fixture();
    const response = await request(order.id, mover.id);
    expect(response.statusCode, response.body).toBe(200);
    await expect(release(order.id, mover.id)).rejects.toThrow();
    expect(await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'PICKED_UP', riderId: mover.rider!.id });
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'PICKED_UP' } })).toBe(1);
  });
  it('the transition helper rejects another actor even with the current generation', async () => {
    const { order } = await fixture();
    const outsider = await actor(true);
    const service = new OrderService(app.prisma, { to: () => ({ emit }) } as never);
    await expect(service.updateRiderStatus(order.id, 'PICKED_UP', outsider.id, 'Synthetic pickup', {
      riderId: outsider.rider!.id, assignmentVersion: order.riderAssignmentVersion,
      allowedFrom: ['RIDER_ARRIVED_PICKUP'],
    })).rejects.toMatchObject({ code: 'ACTOR_NOT_ASSIGNED' });
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id } })).toBe(0);
  });
  it('the database advances on release and reassignment and refuses counter rewrites', async () => {
    const { mover, order } = await fixture();
    const released = await app.prisma.order.update({ where: { id: order.id }, data: { riderId: null, riderAssignmentVersion: 0 } });
    expect(released.riderAssignmentVersion).toBe(order.riderAssignmentVersion + 1);
    const assigned = await app.prisma.order.update({ where: { id: order.id }, data: { riderId: mover.rider!.id } });
    expect(assigned.riderAssignmentVersion).toBe(order.riderAssignmentVersion + 2);
    const rewritten = await app.prisma.order.update({ where: { id: order.id }, data: { riderAssignmentVersion: 0 } });
    expect(rewritten.riderAssignmentVersion).toBe(assigned.riderAssignmentVersion);
  });

});
