// [BUG-HUNT-2 G01] No silent three-day ride. The REAL verification worker handler, on a real database and Redis, under the
// tenant wall (TENANT_UNSCOPED_ACCESS=deny): a ride still in progress far past its estimate raises one platform page, and
// the page closes when no such ride is left.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createWorkers, QUEUE_NAMES, type JobContext } from '../jobs/queue';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { RIDE_OVERDUE_KEY, RIDE_OVERDUE_TITLE } from '../modules/rides/ride-overdue-watch';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone } from './helpers/fixture-ids';

const state = vi.hoisted(() => ({ workers: new Map<string, (job: unknown) => Promise<unknown>>() }));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) { state.workers.set(name, processor); }
    on() { return this; }
    async close() {}
  },
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:ride-overdue-watch');
let app: FastifyInstance;
const ONCALL = testPhone();
const userIds: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const person = (roles: string[], extra: Record<string, unknown> = {}) => sys(async () => {
  const row = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Late', lastName: 'Ride', roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true, ...extra } });
  userIds.push(row.id);
  return row.id;
});

/** A ride in progress: picked up `ago` ms back, with `minutes` on the estimate (null: none on record). */
const ride = (ago: number, minutes: number | null, picked = true, status: 'RIDE_IN_PROGRESS' | 'DRIVER_ARRIVED' = 'RIDE_IN_PROGRESS', pin: { ridePinVerified?: boolean; ridePinVerifiedAt?: Date } = {}) => sys(async () => {
  const customerId = await person(['CUSTOMER']);
  const driverUser = await person(['MOVER', 'CUSTOMER']);
  const driver = await app.prisma.driver.create({ data: {
    userId: driverUser, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', vehicleYear: 2015, licensePlate: `LATE ${nanoid(4)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } as never });
  driverIds.push(driver.id);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `RO-${nanoid(10).toUpperCase()}`, customerId, orderType: 'TAXI', status: 'PENDING', deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
  } as never });
  orderIds.push(order.id);
  await walkOrderStatus(app.prisma, order.id, status, { driverId: driver.id });
  const startedAt = new Date(Date.now() - ago);
  await app.prisma.order.update({ where: { id: order.id }, data: { placedAt: new Date(startedAt.getTime() - 10 * MIN), pickedUpAt: picked ? startedAt : null, taxiDuration: minutes, ...pin } });
  return order.id;
});

const pages = () => sys(() => app.prisma.opsAlert.findMany({ where: { title: RIDE_OVERDUE_TITLE } }));
const texts = () => devChannelLog.filter((entry) => entry.channel === 'sms' && entry.to === ONCALL);
const run = () => state.workers.get(QUEUE_NAMES.VERIFICATION)!({ name: 'ride-overdue-watch', data: {}, attemptsStarted: 1, attemptsMade: 0 });
const clearRides = () => sys(async () => {
  await app.prisma.order.updateMany({ where: { id: { in: orderIds }, status: 'RIDE_IN_PROGRESS' }, data: { status: 'FAILED' } });
  await app.prisma.order.updateMany({ where: { id: { in: orderIds }, status: 'DRIVER_ARRIVED' }, data: { status: 'CANCELLED' } });
});
const wipe = async () => {
  await app.redis.del(RIDE_OVERDUE_KEY);
  await sys(async () => {
    const alerts = await app.prisma.opsAlert.findMany({ where: { title: RIDE_OVERDUE_TITLE }, select: { id: true } });
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: alerts.map((alert) => alert.id) } } });
  });
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['OPS_ONCALL_PHONES'] = ONCALL;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();
  await person(['ADMIN', 'CUSTOMER'], { status: 'ACTIVE', admin: { create: { permissions: ['*'] } } });
  const ctx = { prisma: app.prisma, redis: app.redis, io: { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) }, log } as unknown as JobContext;
  await createWorkers(ctx, {} as never);
  await sys(() => app.prisma.order.updateMany({ where: { orderType: 'TAXI', status: 'RIDE_IN_PROGRESS' }, data: { status: 'FAILED' } }));
});

beforeEach(async () => {
  await clearRides();
  await wipe();
  resetDevChannelLog();
  log.warn.mockClear();
});

afterAll(async () => {
  await wipe();
  await sys(async () => {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  });
  await app.close();
});

describe('a ride open far past its estimate', () => {
  it('pages once through the wall, in one plain text, and a second run stays quiet', async () => {
    const late = await ride(2 * HOUR, 30);
    await run();
    const rows = await pages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'PLATFORM', tenantId: null, sosAlertId: null });
    const { orderNumber } = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: late } }));
    expect(rows[0]!.body).toContain(orderNumber);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]!.body.length).toBeLessThanOrEqual(160);
    expect(texts()[0]!.body).toMatch(/^[\x20-\x7e]+$/);
    expect(log.warn.mock.calls.map((call) => call[1])).toContain('taxi rides open far past their estimate');
    await run();
    expect(await pages()).toHaveLength(1);
    expect(texts()).toHaveLength(1);
  }, 60_000);

  it('one page however many rides, and it counts them', async () => {
    await ride(5 * HOUR, 20);
    const oldest = await ride(72 * HOUR, 20);
    await run();
    const rows = await pages();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain('2 ride(s)');
    expect(rows[0]!.body).toContain((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: oldest } }))).orderNumber);
  }, 60_000);

  it.each([
    ['an hour past the estimate', 92 * MIN, 30, 1],
    ['inside the hour after the estimate', 88 * MIN, 30, 0],
    ['no estimate, past three hours', 181 * MIN, null, 1],
    ['no estimate, inside three hours', 178 * MIN, null, 0],
  ])('%s', async (_name, ago, minutes, expected) => {
    await ride(ago as number, minutes as number | null);
    await run();
    expect(await pages()).toHaveLength(expected as number);
  }, 60_000);

  it('a ride with no pickup time reads from when it was placed', async () => {
    await ride(180 * MIN, 30, false);
    await run();
    expect(await pages()).toHaveLength(1);
  }, 60_000);

  it.each([
    ['the flag', { ridePinVerified: true }],
    ['the older record', { ridePinVerifiedAt: new Date() }],
  ])('a verified code with no Start counts (%s), and an arrival with no code does not', async (_name, pin) => {
    await ride(5 * HOUR, 20, false, 'DRIVER_ARRIVED');
    await run();
    expect(await pages()).toHaveLength(0);
    await ride(5 * HOUR, 20, false, 'DRIVER_ARRIVED', pin);
    await run();
    expect(await pages()).toHaveLength(1);
  }, 60_000);

  it('a ride that closed does not count, and the page closes when none is left', async () => {
    const late = await ride(5 * HOUR, 20);
    await run();
    expect((await pages())[0]!.closedAt).toBeNull();
    await sys(() => app.prisma.order.update({ where: { id: late }, data: { status: 'FAILED' } }));
    await run();
    const [row] = await pages();
    expect(row!.closedAt).not.toBeNull();
  }, 60_000);

  it('only a ride: a delivery on the same status never pages', async () => {
    const late = await ride(5 * HOUR, 20);
    await sys(() => app.prisma.order.update({ where: { id: late }, data: { orderType: 'FOOD_DELIVERY' } }));
    await run();
    expect(await pages()).toHaveLength(0);
  }, 60_000);
});
