import { activateUserBlock } from '../modules/moderation/user-block.service';
import { IncidentService } from '../modules/safety/incident.service';
import { currentMoverDocuments } from './helpers/current-mover-documents';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import courierRoutes from '../modules/courier/courier.routes';
import {
  DispatchService,
  makeDispatchService,
} from '../modules/dispatch/dispatch.service';
import { recordDispatchQueue } from './helpers/dispatch-queue';

// Real HTTP, PostgreSQL and Redis fixtures; providers are local test providers.
const PHONE_PREFIX = '+5920797';
const FIXTURE = 'l07-pair-safety-fixture';
const SPOT = { lat: 3.3803, lng: -59.7968 }; // Lethem
const DROP = { lat: 3.3953, lng: -59.7818 };
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let dispatch: DispatchService;
let seq = 0;
let vendorId = '';
const userIds: string[] = [];
const driverIds: string[] = [];
const riderIds: string[] = [];
const tenantIds: string[] = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type DriverActor = Actor & { driverId: string };
type RiderActor = Actor & { riderId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`,
      firstName: 'Race',
      lastName: `R${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `race-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

const makeCustomer = () => makeUser(['CUSTOMER'], 'CUSTOMER');

/** An online, free, freshly located taxi driver who owns their GO session. */
async function makeDriver(at = SPOT): Promise<DriverActor> {
  const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
      licensePlate: `RACE-${seq}`, driverLicenseUrl: 'storage://race/dl.jpg', vehicleInsuranceUrl: 'storage://race/ins.jpg',
      documentsVerified: true,
      isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: at.lat, currentLng: at.lng, lastLocationUpdate: new Date(),
      acceptanceRate: 50,
    },
  }));
  await sys(() => currentMoverDocuments(app.prisma, u.userId, 'CAR', true));
  driverIds.push(driver.id);
  return { ...u, driverId: driver.id };
}

/** An online, free, freshly located delivery rider with float to spare. */
async function makeRider(at = SPOT): Promise<RiderActor> {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 1_000_000, isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: at.lat, currentLng: at.lng, lastLocationUpdate: new Date(),
      acceptanceRate: 50,
    },
  }));
  riderIds.push(rider.id);
  return { ...u, riderId: rider.id };
}

/** A hailed taxi waiting for a driver, exactly as the request path writes it. */
function makeTaxi(customer: Actor, at = SPOT) {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `RACE-T-${nanoid(10)}`, orderType: 'TAXI', customerId: customer.userId, status: 'PENDING',
      pickupAddress: 'Lethem market', pickupLat: at.lat, pickupLng: at.lng,
      deliveryAddress: 'Lethem airstrip', deliveryLat: DROP.lat, deliveryLng: DROP.lng,
      taxiPickupAddress: 'Lethem market', taxiDropoffAddress: 'Lethem airstrip',
      taxiPassengerCount: 1, rideClass: 'ECONOMY', taxiFareTotal: 1500,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500,
      paymentMethod: 'CASH', ridePin: '482915',
    },
  }));
}

/** A cash food order ready at the kitchen, waiting for a rider. */
function makeDelivery(customer: Actor, dropOffset = 0) {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `RACE-D-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId: customer.userId, vendorId, status: 'READY_FOR_PICKUP',
      pickupAddress: 'Race Kitchen', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Lethem homes', deliveryLat: SPOT.lat + 0.004 + dropOffset, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, paymentMethod: 'CASH',
    },
  }));
}

function call(method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
  });
}

const acceptCard = (mover: Actor, pool: 'driver' | 'rider', orderId: string, offerAttemptId?: string) =>
  call('POST', `/api/v1/${pool}/offers/accept`, mover.token, { orderId, ...(offerAttemptId ? { offerAttemptId } : {}) });
const grabRide = (driver: Actor, orderId: string) => call('POST', `/api/v1/driver/rides/${orderId}/accept`, driver.token, {});
const grabOrder = (rider: Actor, orderId: string) => call('POST', `/api/v1/rider/orders/${orderId}/accept`, rider.token, {});

/** The live card for an order: whose it is, and which generation. */
async function offerOf(orderId: string): Promise<{ moverId: string; attemptId: string } | null> {
  const raw = await app.redis.get(`dispatch:offer:${orderId}`);
  if (!raw) return null;
  const i = raw.indexOf(':');
  return { moverId: raw.slice(0, i), attemptId: raw.slice(i + 1) };
}

async function offer(orderId: string, expected: string) {
  const live = await offerOf(orderId);
  expect(live?.moverId, `the card for ${orderId} went to the wrong mover`).toBe(expected);
  return live!;
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const driverRow = (id: string) => sys(() => app.prisma.driver.findUniqueOrThrow({ where: { id } }));
const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id } }));
const assignmentsOf = (orderId: string, status: 'DRIVER_ASSIGNED' | 'RIDER_ASSIGNED') =>
  sys(() => app.prisma.orderStatusLog.count({ where: { orderId, status } }));

/** Every mover this file made goes offline, so the next race sees only its own. */
async function park() {
  await sys(() => app.prisma.driver.updateMany({
    where: { id: { in: driverIds }, isOnline: true },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  }));
  await sys(() => app.prisma.rider.updateMany({
    where: { id: { in: riderIds }, isOnline: true },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  }));
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const moverDriverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const moverRiderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { driverId: { in: moverDriverIds } }, { riderId: { in: moverRiderIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...moverDriverIds, ...moverRiderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rideQueueEntry.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.supplyWatch.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.incidentCase.deleteMany({ where: { OR: [{ subjectUserId: { in: ids } }, { reporterUserId: { in: ids } }] } });
    await app.prisma.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: ids } }, { blockedId: { in: ids } }] } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: moverDriverIds } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: moverRiderIds } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    if (tenantIds.length > 0) await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await purgeRedis([...ids, ...moverDriverIds, ...moverRiderIds, ...orderIds]);
  });
}

async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'MATCH', 'dispatch:*', 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // Route -> worker hops are recorded, never run: every dispatch pass and every
  // timeout in this file is driven by the test, at the moment the race needs it.
  recordDispatchQueue(app);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  dispatch = makeDispatchService(app);
  await purgeFixtures();

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  vendorId = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Race Kitchen', slug: `race-kitchen-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5920771999',
        addressLine1: '1 Market St', city: 'Lethem', region: 'Upper Takutu-Upper Essequibo',
        latitude: SPOT.lat, longitude: SPOT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    return vendor.id;
  });
}, 120_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await park();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
}, 120_000);

// ---------------------------------------------------------------------------


describe('current pair safety at every assignment door', () => {
  for (const pool of ['driver', 'rider'] as const) {
    for (const door of ['board', 'offer'] as const) {
      it.each(['customer-block', 'mover-block', 'customer-report', 'mover-report', 'shadow'] as const)(`${pool} ${door} refuses %s created after discovery`, async (reason) => {
        const customer = await makeCustomer();
        const mover = pool === 'driver' ? await makeDriver() : await makeRider();
        const moverId = 'driverId' in mover ? mover.driverId : mover.riderId;
        const order = pool === 'driver' ? await makeTaxi(customer) : await makeDelivery(customer);
        const discovery = await dispatch.dispatchOrder(order.id);
        expect(discovery.offered, 'unrestricted pair gets a real card first').toBe(moverId);
        const card = await offer(order.id, moverId);
        if (reason.endsWith('block')) {
          await sys(() => activateUserBlock(app.prisma, {
            tenantId: 'swift-default',
            blockerId: reason === 'customer-block' ? customer.userId : mover.userId,
            blockedId: reason === 'customer-block' ? mover.userId : customer.userId,
          }));
        } else if (reason === 'shadow') {
          await sys(() => app.prisma.user.update({ where: { id: customer.userId }, data: { enhancedSafetyMonitoring: true } }));
          await sys(async () => {
            if (pool === 'driver') await app.prisma.driver.update({ where: { id: moverId }, data: { safetyShadowRestrictedAt: new Date() } });
            else await app.prisma.rider.update({ where: { id: moverId }, data: { safetyShadowRestrictedAt: new Date() } });
          });
        } else {
          await sys(() => new IncidentService(app.prisma, app.io).intake({
            category: 'SERVICE_QUALITY', intake: 'POST_TRIP_REPORT',
            reporterUserId: reason === 'customer-report' ? customer.userId : mover.userId,
            subjectUserId: reason === 'customer-report' ? mover.userId : customer.userId,
            summary: 'Synthetic pair-safety test',
          }));
        }
        const board = await call('GET', `/api/v1/${pool}/${pool === 'driver' ? 'rides' : 'orders'}/available`, mover.token);
        expect(board.statusCode, board.body).toBe(200);
        expect(board.json().data.some((item: { id: string }) => item.id === order.id)).toBe(false);
        const answer = door === 'offer' ? await acceptCard(mover, pool, order.id, card.attemptId)
          : pool === 'driver' ? await grabRide(mover, order.id) : await grabOrder(mover, order.id);
        expect(answer.statusCode, answer.body).toBe(409);
        expect(answer.json().error.code).toBe('JOB_UNAVAILABLE');
        expect(answer.body).not.toMatch(/block|report|shadow|monitor/i);
        const fresh = await orderRow(order.id);
        expect(fresh.driverId).toBeNull();
        expect(fresh.riderId).toBeNull();
        expect(await assignmentsOf(order.id, pool === 'driver' ? 'DRIVER_ASSIGNED' : 'RIDER_ASSIGNED')).toBe(0);
        const row = pool === 'driver' ? await driverRow(moverId) : await riderRow(moverId);
        expect(row.isAvailable).toBe(true);
      });
    }
  }
});
