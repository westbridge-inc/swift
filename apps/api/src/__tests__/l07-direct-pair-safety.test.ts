import { lockUserRoleAuthority } from '../modules/mover-authority';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { OrderService } from '../modules/order/order.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { activateUserBlock, deactivateUserBlock } from '../modules/moderation/user-block.service';
import { IncidentService } from '../modules/safety/incident.service';
import { currentMoverDocuments } from './helpers/current-mover-documents';

// Real database assignment boundaries. Redis and realtime publication are
// synthetic; the separate HTTP suite exercises the board and offer entrances.
let app: FastifyInstance;
const users: string[] = [];
const orders: string[] = [];
let seq = 0;
const io = { to: () => ({ emit: vi.fn() }), emit: vi.fn() };
const redis = new Proxy({}, { get: () => vi.fn(async () => null) });
let dispatch: DispatchService;
let orderService: OrderService;
beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  dispatch = new DispatchService(app.prisma, redis as never, io as never, new HaversineMapsProvider());
  orderService = new OrderService(app.prisma, io as never);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!app) return;
  await app.prisma.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: users } }, { blockedId: { in: users } }] } });
  await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: users } } });
  await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orders } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});
async function fixture(pool: 'DRIVER' | 'RIDER') {
  const customer = await app.prisma.user.create({ data: { firstName: 'Synthetic', lastName: 'Fixture', phone: `+5920786${String(++seq).padStart(4, '0')}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} } } });
  const user = await app.prisma.user.create({ data: { firstName: 'Synthetic', lastName: 'Fixture', phone: `+5920786${String(++seq).padStart(4, '0')}`, roles: [pool], activeRole: pool, selfieCapturedAt: new Date() } });
  users.push(customer.id, user.id);
  const session = await app.prisma.session.create({ data: { userId: user.id, token: nanoid(48), refreshToken: nanoid(48), deviceId: nanoid(12), deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const common = { userId: user.id, isOnline: true, isAvailable: true, documentsVerified: true, locationSessionId: session.id,
    currentLat: 3.38, currentLng: -59.79, lastLocationUpdate: new Date() };
  const mover = pool === 'DRIVER'
    ? await app.prisma.driver.create({ data: { ...common, vehicleMake: 'Toyota', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `L07-P-${seq}`, driverLicenseUrl: 'synthetic', vehicleInsuranceUrl: 'synthetic' } })
    : await app.prisma.rider.create({ data: { ...common, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', floatLimit: 100_000 } });
  if (pool === 'DRIVER') await currentMoverDocuments(app.prisma, user.id, 'CAR', true);
  const order = await app.prisma.order.create({ data: { orderNumber: `L07-P-${nanoid(12)}`, customerId: customer.id,
    orderType: pool === 'DRIVER' ? 'TAXI' : 'FOOD_DELIVERY', status: pool === 'DRIVER' ? 'PENDING' : 'READY_FOR_PICKUP',
    fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', readyAt: new Date(),
    pickupAddress: 'Synthetic pickup', pickupLat: 3.38, pickupLng: -59.79,
    deliveryAddress: 'Synthetic destination', deliveryLat: 3.39, deliveryLng: -59.78,
    subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0, totalAmount: 0, paymentMethod: 'CASH', taxiFareTotal: 0,
  } });
  orders.push(order.id);
  return { customer, user, mover, order };
}

describe('pair safety is checked at the database assignment boundary', () => {
  it('a reactivated block queued first under the mover lock wins over a concurrent claim', async () => {
    const f = await fixture('DRIVER');
    const input = { tenantId: 'swift-default', blockerId: f.customer.id, blockedId: f.user.id };
    await activateUserBlock(app.prisma, input);
    await deactivateUserBlock(app.prisma, input);
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${f.user.id} FOR UPDATE`;
      entered(); await gate;
    }, { timeout: 30_000 });
    await waiting;
    const waiters = async (wanted: number) => {
      const until = Date.now() + 10_000;
      let count = 0;
      while (Date.now() < until) {
        const rows = await app.prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%users%'`;
        count = rows[0]!.count;
        if (count >= wanted) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(count).toBeGreaterThanOrEqual(wanted);
    };
    const block = activateUserBlock(app.prisma, input);
    let claim: Promise<unknown> | undefined;
    try {
      await waiters(1);
      claim = dispatch.claimOrder(f.order.id, f.mover.id, 'DRIVER').then(() => 'assigned', (error: unknown) => error);
      await waiters(2);
    } finally { release(); await held; }
    await block;
    expect(await claim).toMatchObject({ statusCode: 409, code: 'JOB_UNAVAILABLE' });
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).driverId).toBeNull();
  });

  for (const door of ['DRIVER', 'RIDER', 'RIDER_BOARD'] as const) {
    const pool = door === 'DRIVER' ? 'DRIVER' : 'RIDER';
    const claim = (f: Awaited<ReturnType<typeof fixture>>) => door === 'RIDER_BOARD'
      ? app.prisma.$transaction(async (tx) => { await lockUserRoleAuthority(tx, f.user.id); return orderService.stageDirectRiderAssignment(tx, { orderId: f.order.id, riderId: f.mover.id, moverUserId: f.user.id, changedBy: f.user.id }); })
      : dispatch.claimOrder(f.order.id, f.mover.id, pool);
    it.each(['customer-block', 'mover-block', 'customer-report', 'mover-report', 'shadow'] as const)(`${door} refuses %s without assignment effects`, async (reason) => {
      const f = await fixture(pool);
      if (reason.endsWith('block')) {
        await activateUserBlock(app.prisma, { tenantId: 'swift-default', blockerId: reason === 'customer-block' ? f.customer.id : f.user.id, blockedId: reason === 'customer-block' ? f.user.id : f.customer.id });
      } else if (reason === 'shadow') {
        await app.prisma.user.update({ where: { id: f.customer.id }, data: { enhancedSafetyMonitoring: true } });
        if (pool === 'DRIVER') await app.prisma.driver.update({ where: { id: f.mover.id }, data: { safetyShadowRestrictedAt: new Date() } });
        else await app.prisma.rider.update({ where: { id: f.mover.id }, data: { safetyShadowRestrictedAt: new Date() } });
      } else {
        await new IncidentService(app.prisma, io as never).intake({ category: 'SERVICE_QUALITY', intake: 'POST_TRIP_REPORT',
          subjectUserId: reason === 'customer-report' ? f.user.id : f.customer.id,
          reporterUserId: reason === 'customer-report' ? f.customer.id : f.user.id, summary: 'Synthetic pair-safety test' });
      }
      await expect(claim(f)).rejects.toMatchObject({ statusCode: 409, code: 'JOB_UNAVAILABLE' });
      expect(await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject({ riderId: null, driverId: null });
      expect(await app.prisma.orderStatusLog.count({ where: { orderId: f.order.id } })).toBe(0);
    });
    it(`${door} still assigns an unrestricted pair`, async () => {
      const f = await fixture(pool);
      await claim(f);
      expect(await app.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject(pool === 'DRIVER' ? { driverId: f.mover.id, status: 'DRIVER_ASSIGNED' } : { riderId: f.mover.id, status: 'RIDER_ASSIGNED' });
    });
  }
});
