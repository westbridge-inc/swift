import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  DISPATCH_LOCATION_FRESH_SECONDS,
  DispatchService,
  normalizeDispatchLocationFreshSeconds,
} from '../modules/dispatch/dispatch.service';
import { scoreCandidate, rankCandidates } from '../modules/dispatch/scoring';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { runWithoutTenant } from '../plugins/tenant-context';
import { transitionUserRoleAuthority, transitionUserStatusAuthority } from '../modules/mover-authority';
import { FloatService } from '../modules/dispatch/float.service';
import { OrderService } from '../modules/order/order.service';
import { AuthService } from '../modules/auth/auth.service';

// ---------------------------------------------------------------------------
// dispatch. Hardest paths: the no-acceptance path
// (food cooked, nobody coming — must end in an honest message), riders
// vanishing mid-offer, and duplicate acceptance. The DB compare-and-set is
// the real lock: ten simultaneous accepts produce exactly one winner.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PICKUP = { lat: 6.8, lng: -58.15 };

let app: FastifyInstance;
let dispatch: DispatchService;
const scheduled: Array<{ orderId: string; riderId: string; delayMs: number }> = [];

const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdTenantIds: string[] = [];
let vendorOwnerUserId: string;
let vendorId: string;
let customerId: string;

/** Idempotent sweep — survives interrupted previous runs. */
async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { OR: [{ phone: { startsWith: '+59200088' } }, { phone: { in: ['+5920009901', '+5920009902'] } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;

  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { rider: { userId: { in: ids } } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  // Carts have a restrict FK to the customer — must go before the user or the
  // whole user.deleteMany fails atomically and strands every fixture.
  await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeRider(opts: {
  lat?: number; lng?: number; online?: boolean; available?: boolean;
    rating?: number; acceptance?: number; busy?: boolean; tenantId?: string;
    lastLocationUpdate?: Date | null;
}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      // 3-digit pad: the generated range (+59200088001…) can never collide
      // with the file's two hardcoded admin phones (+5920008877/99), which sat
      // inside the old 2-digit space and broke the run once seq reached them.
      phone: `+59200088${String(seq).padStart(3, '0')}`,
      firstName: 'Dispatch',
      lastName: `Rider${seq}`,
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole],
      activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
  });
  createdUserIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      // D.3 float gate: a verified, dispatch-eligible rider has float headroom.
      // Production sets this via FloatService.recomputeForUser on rider creation/
      // verification; this helper writes the rider row directly, so set it high
      // enough that CASH offers aren't filtered out by the dispatch float gate.
      floatLimit: 1_000_000,
      isOnline: opts.online ?? true,
      isAvailable: opts.available ?? true,
      currentLat: opts.lat ?? PICKUP.lat,
      currentLng: opts.lng ?? PICKUP.lng,
      lastLocationUpdate: opts.lastLocationUpdate === undefined ? new Date() : opts.lastLocationUpdate,
      averageRating: opts.rating ?? 5,
      acceptanceRate: opts.acceptance ?? 100,
      currentOrderId: opts.busy ? 'busy-elsewhere' : null,
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'step8', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  await app.prisma.rider.update({
    where: { id: rider.id },
    data: { locationSessionId: session.id },
  });
  return { userId: user.id, riderId: rider.id, token, sessionId: session.id };
}

async function makeRiderDeviceSession(userId: string, deviceId: string) {
  const token = app.jwt.sign({ userId, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId,
      token,
      refreshToken: nanoid(48),
      deviceId,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { token, sessionId: session.id };
}

async function makeDeliveryOrder(status: 'ACCEPTED' | 'READY_FOR_PICKUP' = 'ACCEPTED', pickup = PICKUP) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `S8-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status,
      fulfillment: 'DELIVERY',
      pickupAddress: 'Vendor HQ',
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      deliveryAddress: 'Customer place',
      deliveryLat: pickup.lat + 0.01,
      deliveryLng: pickup.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  dispatch = new DispatchService(
    app.prisma,
    app.redis,
    app.io,
    new HaversineMapsProvider(),
    async (orderId, riderId, delayMs) => {
      scheduled.push({ orderId, riderId, delayMs });
    },
  );

  await purgeFixtures();

  // Customer + vendor scaffolding for orders
  const customer = await app.prisma.user.create({
    data: {
      phone: '+5920009901', firstName: 'Dispatch', lastName: 'Customer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  createdUserIds.push(customer.id);
  customerId = customer.id;

  const ownerUser = await app.prisma.user.create({
    data: {
      phone: '+5920009902', firstName: 'Dispatch', lastName: 'Vendor',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(ownerUser.id);
  vendorOwnerUserId = ownerUser.id;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: 'Dispatch Diner', slug: 'dispatch-diner',
      vendorType: 'RESTAURANT', phone: '+5920009903',
      addressLine1: '1 Dispatch Drive', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

describe('Rider location authority', () => {
  it('cannot reclaim a legacy null owner after its in-flight session is revoked', async () => {
    const r = await makeRider({ online: true, available: true, lat: 6.831, lng: -58.171 });
    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { locationSessionId: null },
    });
    await app.redis.del(`rider:location_db_ts:${r.riderId}`);

    let reachedProfileRead!: () => void;
    let resumeProfileRead!: () => void;
    const atProfileRead = new Promise<void>((resolve) => { reachedProfileRead = resolve; });
    const resume = new Promise<void>((resolve) => { resumeProfileRead = resolve; });
    const originalFindUnique = app.prisma.rider.findUnique.bind(app.prisma.rider);
    const profileRead = vi.spyOn(app.prisma.rider, 'findUnique').mockImplementationOnce((async (...args: unknown[]) => {
      const profile = await originalFindUnique(...(args as [Parameters<typeof originalFindUnique>[0]]));
      reachedProfileRead();
      await resume;
      return profile;
    }) as never);

    let staleSample!: Awaited<ReturnType<typeof app.inject>>;
    try {
      const staleSamplePromise = app.inject({
        method: 'PUT',
        url: '/api/v1/rider/location',
        payload: { latitude: 6.99, longitude: -58.29 },
        headers: { authorization: `Bearer ${r.token}` },
      });
      await atProfileRead;
      await new AuthService(app).logout(r.sessionId, r.userId);
      resumeProfileRead();
      staleSample = await staleSamplePromise;
    } finally {
      resumeProfileRead();
      profileRead.mockRestore();
    }

    expect(staleSample.statusCode).toBe(200);
    expect(staleSample.json().data).toEqual({ accepted: false, reason: 'SESSION_REPLACED' });
    const [after, revoked] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } }),
      app.prisma.session.findUnique({ where: { id: r.sessionId } }),
    ]);
    expect(revoked).toBeNull();
    expect(after.locationSessionId).toBeNull();
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.831, lng: -58.171 });
    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('rotates GO ownership to the latest device and rejects the replaced session', async () => {
    const r = await makeRider({ online: false, available: false });
    const secondDevice = await makeRiderDeviceSession(r.userId, 'step8-second-device');

    const firstGo = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload: { latitude: 6.801, longitude: -58.151 },
      headers: { authorization: `Bearer ${r.token}` },
    });
    expect(firstGo.statusCode).toBe(200);
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } })).locationSessionId)
      .toBe(r.sessionId);

    const secondGo = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload: { latitude: 6.802, longitude: -58.152 },
      headers: { authorization: `Bearer ${secondDevice.token}` },
    });
    expect(secondGo.statusCode).toBe(200);
    const afterReplacement = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(afterReplacement.locationSessionId).toBe(secondDevice.sessionId);
    expect({ lat: afterReplacement.currentLat, lng: afterReplacement.currentLng })
      .toEqual({ lat: 6.802, lng: -58.152 });

    await app.redis.del(`rider:location_db_ts:${r.riderId}`);
    const replacedSample = await app.inject({
      method: 'PUT',
      url: '/api/v1/rider/location',
      payload: { latitude: 6.91, longitude: -58.21 },
      headers: { authorization: `Bearer ${r.token}` },
    });
    expect(replacedSample.statusCode).toBe(200);
    expect(replacedSample.json().data).toEqual({ accepted: false, reason: 'SESSION_REPLACED' });
    const afterRejectedSample = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect({ lat: afterRejectedSample.currentLat, lng: afterRejectedSample.currentLng })
      .toEqual({ lat: 6.802, lng: -58.152 });

    const ownerSample = await app.inject({
      method: 'PUT',
      url: '/api/v1/rider/location',
      payload: { latitude: 6.803, longitude: -58.153 },
      headers: { authorization: `Bearer ${secondDevice.token}` },
    });
    expect(ownerSample.statusCode).toBe(200);
    expect(ownerSample.json()).toEqual({ success: true });
    const afterOwnerSample = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect({ lat: afterOwnerSample.currentLat, lng: afterOwnerSample.currentLng })
      .toEqual({ lat: 6.803, lng: -58.153 });

    const offline = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-offline',
      headers: { authorization: `Bearer ${secondDevice.token}` },
    });
    expect(offline.statusCode).toBe(200);
    const afterOffline = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(afterOffline.locationSessionId).toBeNull();
    expect(afterOffline.isOnline).toBe(false);
  });

  it('does not emit an old-device sample when GO rotates during a debounced update', async () => {
    const r = await makeRider({ online: false, available: false });
    const secondDevice = await makeRiderDeviceSession(r.userId, 'step8-race-winner');
    const firstGo = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload: { latitude: 6.841, longitude: -58.181 },
      headers: { authorization: `Bearer ${r.token}` },
    });
    expect(firstGo.statusCode).toBe(200);

    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    await app.prisma.$transaction([
      app.prisma.order.update({
        where: { id: order.id },
        data: { riderId: r.riderId, status: 'RIDER_ASSIGNED' },
      }),
      app.prisma.rider.update({
        where: { id: r.riderId },
        data: { currentOrderId: order.id, isAvailable: false },
      }),
    ]);

    let reachedDebounce!: () => void;
    let resumeDebounce!: () => void;
    const atDebounce = new Promise<void>((resolve) => { reachedDebounce = resolve; });
    const resume = new Promise<void>((resolve) => { resumeDebounce = resolve; });
    const originalRedisGet = app.redis.get.bind(app.redis);
    const redisGet = vi.spyOn(app.redis, 'get').mockImplementationOnce((async (...args: unknown[]) => {
      reachedDebounce();
      await resume;
      return originalRedisGet(...(args as [string]));
    }) as never);
    const emits: Array<{ room: string; event: string }> = [];
    const ioTo = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
      emit: (event: string) => { emits.push({ room, event }); return true; },
    })) as never);

    let replacement!: Awaited<ReturnType<typeof app.inject>>;
    let oldSample!: Awaited<ReturnType<typeof app.inject>>;
    try {
      const oldSamplePromise = app.inject({
        method: 'PUT',
        url: '/api/v1/rider/location',
        payload: { latitude: 6.99, longitude: -58.29 },
        headers: { authorization: `Bearer ${r.token}` },
      });
      await atDebounce;

      replacement = await app.inject({
        method: 'POST',
        url: '/api/v1/rider/go-online',
        payload: { latitude: 6.842, longitude: -58.182 },
        headers: { authorization: `Bearer ${secondDevice.token}` },
      });
      resumeDebounce();
      oldSample = await oldSamplePromise;
    } finally {
      resumeDebounce();
      redisGet.mockRestore();
      ioTo.mockRestore();
    }

    expect(replacement.statusCode).toBe(200);
    expect(oldSample.statusCode).toBe(200);
    expect(oldSample.json().data).toEqual({ accepted: false, reason: 'SESSION_REPLACED' });
    expect(emits).not.toContainEqual({ room: `order:${order.id}`, event: 'rider:location' });
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(after.locationSessionId).toBe(secondDevice.sessionId);
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.842, lng: -58.182 });
  });

  it('atomically gives a legacy null owner to one device and clears it on role retirement', async () => {
    const r = await makeRider({ online: true });
    const secondDevice = await makeRiderDeviceSession(r.userId, 'step8-legacy-contender');
    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { locationSessionId: null },
    });
    await app.redis.del(`rider:location_db_ts:${r.riderId}`);

    const samples = [
      { latitude: 6.811, longitude: -58.161 },
      { latitude: 6.812, longitude: -58.162 },
    ];
    const responses = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/api/v1/rider/location',
        payload: samples[0],
        headers: { authorization: `Bearer ${r.token}` },
      }),
      app.inject({
        method: 'PUT',
        url: '/api/v1/rider/location',
        payload: samples[1],
        headers: { authorization: `Bearer ${secondDevice.token}` },
      }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const bodies = responses.map((response) => response.json());
    expect(bodies.filter((body) => body.data?.reason === 'SESSION_REPLACED')).toHaveLength(1);
    expect(bodies.filter((body) => body.data === undefined)).toHaveLength(1);

    const winningIndex = bodies.findIndex((body) => body.data === undefined);
    const expectedSessionIds = [r.sessionId, secondDevice.sessionId];
    const claimed = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(claimed.locationSessionId).toBe(expectedSessionIds[winningIndex]);
    expect({ lat: claimed.currentLat, lng: claimed.currentLng }).toEqual({
      lat: samples[winningIndex]!.latitude,
      lng: samples[winningIndex]!.longitude,
    });

    await transitionUserRoleAuthority(app, r.userId, 'CUSTOMER');
    const retired = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(retired.locationSessionId).toBeNull();
    expect({ online: retired.isOnline, available: retired.isAvailable }).toEqual({
      online: false,
      available: false,
    });
  });

  it('atomically stores the fresh GO coordinate', async () => {
    const r = await makeRider({ online: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload: { latitude: 6.8234, longitude: -58.1678 },
      headers: { authorization: `Bearer ${r.token}` },
    });

    expect(res.statusCode).toBe(200);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.8234, lng: -58.1678 });
    expect(after.lastLocationUpdate).not.toBeNull();
    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it.each([
    ['empty', {}],
    ['one-sided', { latitude: 6.8234 }],
  ])('rejects a %s GO coordinate without advertising supply', async (_label, payload) => {
    const r = await makeRider({ online: false, available: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload,
      headers: { authorization: `Bearer ${r.token}` },
    });

    expect(res.statusCode).toBe(400);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(after.isOnline).toBe(false);
    expect(after.isAvailable).toBe(false);
  });

  it('returns DB-authoritative GO success when Redis bookkeeping is unavailable', async () => {
    const r = await makeRider({ online: false, available: false });
    const redisSet = vi.spyOn(app.redis, 'set').mockRejectedValueOnce(new Error('redis down'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/rider/go-online',
        payload: { latitude: 6.8234, longitude: -58.1678 },
        headers: { authorization: `Bearer ${r.token}` },
      });
      expect(res.statusCode).toBe(200);
      const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
      expect(after.isOnline).toBe(true);
      expect(after.lastLocationUpdate).not.toBeNull();
    } finally {
      redisSet.mockRestore();
      await app.prisma.rider.update({
        where: { id: r.riderId },
        data: { isOnline: false, isAvailable: false },
      });
    }
  });

  it('retires idle taxi supply before the same unified mover becomes delivery supply', async () => {
    const r = await makeRider({ online: false, available: false });
    const driver = await app.prisma.driver.create({
      data: {
        userId: r.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
        vehicleColor: 'Silver', licensePlate: `DUAL-${seq}`,
        driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', documentsVerified: true,
        isOnline: true, isAvailable: true,
        currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload: { latitude: 6.8234, longitude: -58.1678 },
      headers: { authorization: `Bearer ${r.token}` },
    });
    expect(res.statusCode).toBe(200);
    const afterDriver = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect({ online: afterDriver.isOnline, available: afterDriver.isAvailable }).toEqual({
      online: false,
      available: false,
    });
    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('refuses delivery GO while the same unified mover has an active taxi ride', async () => {
    const r = await makeRider({ online: false, available: false });
    const driver = await app.prisma.driver.create({
      data: {
        userId: r.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
        vehicleColor: 'Silver', licensePlate: `ACTIVE-${seq}`,
        driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', documentsVerified: true,
        isOnline: true, isAvailable: false, currentRideId: 'active-sibling-ride',
        currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload: { latitude: 6.8234, longitude: -58.1678 },
      headers: { authorization: `Bearer ${r.token}` },
    });
    expect(res.statusCode).toBe(409);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after.currentRideId).toBe('active-sibling-ride');
    expect(after.isOnline).toBe(true);
    await app.prisma.driver.update({
      where: { id: driver.id },
      data: { currentRideId: null, isOnline: false, isAvailable: false },
    });
  });

  it('persists an active location sample when Redis debounce is unavailable', async () => {
    const r = await makeRider({ online: true });
    const redisGet = vi.spyOn(app.redis, 'get').mockRejectedValueOnce(new Error('redis down'));
    const redisSet = vi.spyOn(app.redis, 'set').mockRejectedValueOnce(new Error('redis down'));
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/rider/location',
        payload: { latitude: 6.8334, longitude: -58.1778 },
        headers: { authorization: `Bearer ${r.token}` },
      });
      expect(res.statusCode).toBe(200);
      const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
      expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.8334, lng: -58.1778 });
    } finally {
      redisGet.mockRestore();
      redisSet.mockRestore();
      await app.prisma.rider.update({
        where: { id: r.riderId },
        data: { isOnline: false, isAvailable: false },
      });
    }
  });

  it('rejects an offline queued sample without writing or arming the debounce key', async () => {
    const r = await makeRider({ online: false, lat: 6.8, lng: -58.15 });
    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isAvailable: false, currentOrderId: null },
    });
    await app.redis.del(`rider:location_db_ts:${r.riderId}`);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/rider/location',
      payload: { latitude: 6.91, longitude: -58.21 },
      headers: { authorization: `Bearer ${r.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ accepted: false, reason: 'OFFLINE' });
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.8, lng: -58.15 });
    expect(await app.redis.get(`rider:location_db_ts:${r.riderId}`)).toBeNull();
  });

  it('accepts online samples and force-offlined samples with an active job pointer', async () => {
    const online = await makeRider({ online: true });
    await app.redis.del(`rider:location_db_ts:${online.riderId}`);
    const onlineRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/rider/location',
      payload: { latitude: 6.82, longitude: -58.16 },
      headers: { authorization: `Bearer ${online.token}` },
    });
    expect(onlineRes.statusCode).toBe(200);
    await app.prisma.rider.update({
      where: { id: online.riderId },
      data: { isOnline: false, isAvailable: false },
    });

    const active = await makeRider({ online: false });
    const order = await makeDeliveryOrder();
    await app.prisma.order.update({
      where: { id: order.id },
      data: { riderId: active.riderId, status: 'RIDER_ASSIGNED' },
    });
    await app.prisma.rider.update({
      where: { id: active.riderId },
      data: { isAvailable: false, currentOrderId: order.id },
    });
    await app.redis.del(`rider:location_db_ts:${active.riderId}`);
    const activeRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/rider/location',
      payload: { latitude: 6.83, longitude: -58.17 },
      headers: { authorization: `Bearer ${active.token}` },
    });
    expect(activeRes.statusCode).toBe(200);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: active.riderId } });
    expect({ lat: after.currentLat, lng: after.currentLng }).toEqual({ lat: 6.83, lng: -58.17 });
  });
});

afterAll(async () => {
  // The HTTP accept tests run authenticate -> enterTenant, whose enterWith
  // leaks a tenant into this async context; without clearing it, purge's
  // findMany is scoped to swift-default and never sees the foreign-tenant rider.
  await runWithoutTenant(async () => {
    await purgeFixtures(); // deletes the fixture users (incl. the foreign-tenant rider) by phone
    // Now that no user points at them, the throwaway tenants can go.
    if (createdTenantIds.length) await app.prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  });
  await app.close();
});

describe('Scoring — pure and predictable', () => {
  it('keeps the dispatch lease safely above the 30s mobile heartbeat', () => {
    expect(normalizeDispatchLocationFreshSeconds(30)).toBe(90);
    expect(normalizeDispatchLocationFreshSeconds('bad')).toBe(90);
    expect(normalizeDispatchLocationFreshSeconds(180)).toBe(180);
  });

  const base = { riderId: 'r', userId: 'u', etaMinutes: 5, averageRating: 5, acceptanceRate: 100, hasActiveJob: false };

  it('closer beats further, all else equal', () => {
    expect(scoreCandidate({ ...base, etaMinutes: 2 })).toBeLessThan(scoreCandidate({ ...base, etaMinutes: 20 }));
  });

  it('an idle rider beats a loaded one at similar distance', () => {
    expect(scoreCandidate({ ...base, hasActiveJob: false })).toBeLessThan(scoreCandidate({ ...base, hasActiveJob: true }));
  });

  it('chronic decliners drift down', () => {
    expect(scoreCandidate({ ...base, acceptanceRate: 95 })).toBeLessThan(scoreCandidate({ ...base, acceptanceRate: 20 }));
  });

  it('rating breaks ties', () => {
    expect(scoreCandidate({ ...base, averageRating: 4.9 })).toBeLessThan(scoreCandidate({ ...base, averageRating: 3.0 }));
  });

  it('ranks a field deterministically', () => {
    const near = { ...base, riderId: 'near', etaMinutes: 2 };
    const nearButBusy = { ...base, riderId: 'busy', etaMinutes: 2.5, hasActiveJob: true };
    const far = { ...base, riderId: 'far', etaMinutes: 25 };
    expect(rankCandidates([far, nearButBusy, near]).map((c) => c.riderId)).toEqual(['near', 'busy', 'far']);
  });
});

describe('Candidate discovery — PostGIS radius', () => {
  it('excludes an online rider whose location authority has no owning session', async () => {
    const rider = await makeRider({ lat: PICKUP.lat + 0.001 });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { locationSessionId: null },
    });

    const ids = (await dispatch.findCandidates(`ownerless-${nanoid(6)}`, PICKUP, 5))
      .map((candidate) => candidate.riderId);
    expect(ids).not.toContain(rider.riderId);
    await expect((dispatch as unknown as {
      canReceiveOffer(pool: 'RIDER', moverId: string): Promise<boolean>;
    }).canReceiveOffer('RIDER', rider.riderId)).resolves.toBe(false);

    const board = await app.inject({
      method: 'GET',
      url: '/api/v1/rider/orders/available',
      headers: { authorization: `Bearer ${rider.token}` },
    });
    expect(board.statusCode).toBe(400);
    expect(board.json().error.code).toBe('OFFLINE');
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
  });

  it('atomically removes an owning rider session from dispatch supply on logout', async () => {
    const rider = await makeRider({ lat: PICKUP.lat + 0.001 });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { locationSessionId: rider.sessionId },
    });

    const before = await dispatch.findCandidates(`logout-before-${nanoid(6)}`, PICKUP, 5);
    expect(before.map((candidate) => candidate.riderId)).toContain(rider.riderId);

    await new AuthService(app).logout(rider.sessionId, rider.userId);

    const [profile, revokedSession, after] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
      app.prisma.session.findUnique({ where: { id: rider.sessionId } }),
      dispatch.findCandidates(`logout-after-${nanoid(6)}`, PICKUP, 5),
    ]);
    expect({
      locationSessionId: profile.locationSessionId,
      isOnline: profile.isOnline,
      isAvailable: profile.isAvailable,
    }).toEqual({ locationSessionId: null, isOnline: false, isAvailable: false });
    expect(revokedSession).toBeNull();
    expect(after.map((candidate) => candidate.riderId)).not.toContain(rider.riderId);
  });

  it('finds online riders inside the radius and excludes the rest', async () => {
    const near = await makeRider({ lat: PICKUP.lat + 0.0045 });            // ~0.5 km
    const mid = await makeRider({ lat: PICKUP.lat + 0.018 });              // ~2 km
    const offline = await makeRider({ lat: PICKUP.lat + 0.002, online: false });
    const farAway = await makeRider({ lat: PICKUP.lat + 0.45 });           // ~50 km

    const order = await makeDeliveryOrder();
    const candidates = await dispatch.findCandidates(order.id, PICKUP, 5);
    const ids = candidates.map((c) => c.riderId);

    expect(ids).toContain(near.riderId);
    expect(ids).toContain(mid.riderId);
    expect(ids).not.toContain(offline.riderId);
    expect(ids).not.toContain(farAway.riderId);
    expect(ids[0]).toBe(near.riderId); // ranked: nearest idle first

    // cleanup riders for later scenarios
    await app.prisma.rider.updateMany({
      where: { id: { in: [near.riderId, mid.riderId] } },
      data: { isOnline: false },
    });
  });

  it('treats fresh location plus active mover role as a renewable supply lease', async () => {
    const fresh = await makeRider({ lat: PICKUP.lat + 0.001 });
    const stale = await makeRider({
      lat: PICKUP.lat + 0.0015,
      lastLocationUpdate: new Date(Date.now() - (DISPATCH_LOCATION_FRESH_SECONDS + 5) * 1000),
    });
    const wrongSurface = await makeRider({ lat: PICKUP.lat + 0.002 });
    const suspended = await makeRider({ lat: PICKUP.lat + 0.0025 });
    await app.prisma.user.update({
      where: { id: wrongSurface.userId },
      data: { activeRole: 'CUSTOMER' },
    });
    await app.prisma.user.update({
      where: { id: suspended.userId },
      data: { status: 'SUSPENDED' },
    });
    const order = await makeDeliveryOrder();

    const ids = (await dispatch.findCandidates(order.id, PICKUP, 5)).map((candidate) => candidate.riderId);
    expect(ids).toContain(fresh.riderId);
    expect(ids).not.toContain(stale.riderId);
    expect(ids).not.toContain(wrongSurface.riderId);
    expect(ids).not.toContain(suspended.riderId);

    await app.prisma.rider.updateMany({
      where: { id: { in: [fresh.riderId, stale.riderId, wrongSurface.riderId, suspended.riderId] } },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('never offers across tenants — a mover in another operator is invisible (raw geo query bypasses tenantScope)', async () => {
    // A second operator on the same platform. Both riders sit on the SAME remote
    // spot, far from every other fixture, so tenancy is the ONLY thing that can
    // separate them.
    const FAR = { lat: 6.95, lng: -58.42 };
    const { otherTenant, foreign, local, order } = await runWithoutTenant(async () => {
      const tenant = await app.prisma.tenant.create({
        data: { name: 'Other Op', slug: `other-${nanoid(6).toLowerCase()}` },
      });
      createdTenantIds.push(tenant.id);
      return {
        otherTenant: tenant,
        foreign: await makeRider({ lat: FAR.lat, lng: FAR.lng, tenantId: tenant.id }),
        local: await makeRider({ lat: FAR.lat, lng: FAR.lng }), // swift-default
        order: await makeDeliveryOrder('ACCEPTED', FAR), // swift-default
      };
    });

    // Dispatching a swift-default order must see the local rider and NOT the
    // foreign one — even though the foreign rider is an identical, closer-or-equal
    // candidate. This is the assertion that fails without the JOIN+tenant filter.
    const forDefault = await dispatch.findCandidates(order.id, FAR, 5, 'RIDER', 0, null, 'swift-default');
    const defaultIds = forDefault.map((c) => c.riderId);
    expect(defaultIds).toContain(local.riderId);
    expect(defaultIds).not.toContain(foreign.riderId);

    // And the other operator sees only its own rider — never the default one.
    const forOther = await dispatch.findCandidates(order.id, FAR, 5, 'RIDER', 0, null, otherTenant.id);
    const otherIds = forOther.map((c) => c.riderId);
    expect(otherIds).toContain(foreign.riderId);
    expect(otherIds).not.toContain(local.riderId);

    await app.prisma.rider.updateMany({ where: { id: { in: [foreign.riderId, local.riderId] } }, data: { isOnline: false } });
  });
});

describe('Availability — float-aware supply (matches the dispatch cash-float gate)', () => {
  it('a rider without the float headroom to front a cash order is not counted', async () => {
    const SPOT = { lat: 6.42, lng: -57.92 }; // remote — no other fixtures in range
    const r = await makeRider({ lat: SPOT.lat, lng: SPOT.lng });
    // Only 5,000 GYD of free float.
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { floatLimit: 5000, committedFloat: 0 } });

    // Browsing (float 0) and a small order within the rider's headroom: counted.
    expect((await dispatch.getAvailability('RIDER', SPOT, 0)).level).not.toBe('NONE');
    expect((await dispatch.getAvailability('RIDER', SPOT, 5000)).level).not.toBe('NONE');

    // A 12,000 GYD cash order needs more float than the rider has → NONE, the
    // SAME rider dispatch's cash-float gate would skip (no false "yes").
    expect((await dispatch.getAvailability('RIDER', SPOT, 12000)).level).toBe('NONE');

    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false } });
  });
});

describe('The offer cascade', () => {
  it('offers best-first, walks the field on decline/timeout, and honest-fails when empty', async () => {
    const a = await makeRider({ lat: PICKUP.lat + 0.0045, acceptance: 100 }); // best
    const b = await makeRider({ lat: PICKUP.lat + 0.018, acceptance: 100 }); // next
    const order = await makeDeliveryOrder();
    // An admin who should be paged when the pool goes dead (SWIFT-AUD-D7-02).
    const admin = await app.prisma.user.create({
      data: { phone: '+5920008899', firstName: 'Ops', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true },
    });
    createdUserIds.push(admin.id);

    // 1) Best candidate gets the offer + a timeout is scheduled
    const first = await dispatch.dispatchOrder(order.id);
    expect(first.offered).toBe(a.riderId);
    expect(scheduled.at(-1)).toMatchObject({ orderId: order.id, riderId: a.riderId, delayMs: 20_000 });

    // 2) A declines -> B is offered; A's acceptance EMA dropped
    await dispatch.declineOffer(order.id, a.userId);
    const offerNow = await app.redis.get(`dispatch:offer:${order.id}`);
    expect(offerNow!.split(':')[0]).toBe(b.riderId); // value is `<mover>:<attemptId>` [F-014-04]
    const aAfter = await app.prisma.rider.findUniqueOrThrow({ where: { id: a.riderId } });
    expect(aAfter.acceptanceRate).toBeLessThan(100);

    // 3) B times out (goes dark mid-offer) -> nobody left in 5km -> radius
    //    widens -> still nobody -> honest exhaustion to customer AND vendor
    await dispatch.handleOfferTimeout(order.id, b.riderId);

    const customerNote = await app.prisma.notification.findFirst({
      where: { userId: customerId, title: 'No movers available right now' },
    });
    const vendorNote = await app.prisma.notification.findFirst({
      where: { userId: vendorOwnerUserId, title: 'No movers available' },
    });
    expect(customerNote).not.toBeNull();
    expect(vendorNote).not.toBeNull();

    // Ops is paged too — a dead mover pool must not be invisible (D7-02).
    const adminNote = await app.prisma.notification.findFirst({
      where: { userId: admin.id, title: 'Dispatch exhausted — no mover found' },
    });
    expect(adminNote).not.toBeNull();

    const final = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, riderId: true } });
    expect(final.riderId).toBeNull();
    expect(final.status).toBe('ACCEPTED'); // never a silent hang, never a fake assignment

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });

  it('two concurrent offer outcomes serialize under the row lock — neither is lost [REPORT-014 F-014-14]', async () => {
    const rider = await makeRider({ lat: PICKUP.lat + 0.02, acceptance: 100 });
    // Two misses land at the same instant. The old read-modify-write let both
    // read 100 and write 80 (a lost update); the atomic EMA serializes to
    // 100 → 80 → 64. (recordOfferOutcome is private; runtime-erased.)
    const record = (dispatch as unknown as { recordOfferOutcome: (id: string, ok: boolean, pool: string) => Promise<void> }).recordOfferOutcome.bind(dispatch);
    await Promise.all([record(rider.riderId, false, 'RIDER'), record(rider.riderId, false, 'RIDER')]);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(Number(after.acceptanceRate)).toBeCloseTo(64, 5); // NOT 80 (would be a lost update)
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false } });
  });

  it('SWIFT-016: accepting via /offers/accept claims, applies the fare, and never a timeout penalty', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } });
    const rider = await makeRider({ lat: PICKUP.lat + 0.002, acceptance: 100 });
    const order = await makeDeliveryOrder();

    // The offer lands on the rider (offerKey set, alert created, timeout scheduled).
    const offered = await dispatch.dispatchOrder(order.id);
    expect(offered.offered).toBe(rider.riderId);

    // Accept through the OFFER path (what the offer card now calls), undercutting
    // the 500 market fee to 300.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rider/offers/accept',
      headers: { authorization: `Bearer ${rider.token}`, 'content-type': 'application/json' },
      payload: { orderId: order.id, fare: 300 },
    });
    expect(res.statusCode).toBe(200);

    const claimed = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(claimed.riderId).toBe(rider.riderId);
    expect(claimed.status).toBe('RIDER_ASSIGNED');
    expect(Number(claimed.deliveryFee)).toBe(300); // rider-set fee applied

    // The originally-scheduled offer timeout fires. Because acceptOffer cleared
    // the offer, it must NOT penalise the rider who accepted.
    await dispatch.handleOfferTimeout(order.id, rider.riderId);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    // RED before SWIFT-016: the offer card hit board-grab, which left the offer
    // live, so this timeout scored a miss and dropped acceptanceRate below 100.
    expect(after.acceptanceRate).toBe(100);
    await app.prisma.rider.updateMany({ where: { id: rider.riderId }, data: { isOnline: false } });
  });

  it('SWIFT-065: exhaustion is terminal — long-TTL marker + admins paged once, not every hour', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } }); // guarantee an empty pool
    const order = await makeDeliveryOrder();
    const admin = await app.prisma.user.create({
      data: { phone: '+5920008877', firstName: 'Ops2', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true },
    });
    createdUserIds.push(admin.id);

    // First full exhaustion (widens through every round, finds no candidate).
    const r1 = await dispatch.dispatchOrder(order.id);
    expect(r1).toMatchObject({ exhausted: true });

    // The attempt marker now persists far longer than the old 1h TTL, so the
    // reconciler leaves this stranded order alone instead of re-cascading hourly.
    const ttl = await app.redis.ttl(`dispatch:exhausts:${order.id}`);
    expect(ttl).toBeGreaterThan(3600);

    const pagedOnce = await app.prisma.notification.count({
      where: { userId: admin.id, title: 'Dispatch exhausted — no mover found' },
    });
    expect(pagedOnce).toBe(1);

    // A second exhaustion of the SAME order must NOT re-page the admins.
    await dispatch.dispatchOrder(order.id);
    const pagedAfter = await app.prisma.notification.count({
      where: { userId: admin.id, title: 'Dispatch exhausted — no mover found' },
    });
    // RED before SWIFT-065: 2 — admins were paged on every re-exhaust.
    expect(pagedAfter).toBe(1);

    await app.redis.del(`dispatch:exhausts:${order.id}`, `ops_page:dispatch_exhausted:${order.id}`);
  });

  it('a fully-exhausted search emits dispatch:exhausted to the rider live screen (no infinite spinner)', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } }); // empty pool -> terminal exhaustion
    const order = await makeDeliveryOrder();
    const emits: Array<{ room: string; ev: string }> = [];
    const spy = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
      emit: (ev: string) => { emits.push({ room, ev }); return true; },
    })) as never);
    try {
      const r = await dispatch.dispatchOrder(order.id);
      expect(r).toMatchObject({ exhausted: true });
    } finally {
      spy.mockRestore();
    }
    // The rider's open ActiveRide screen gets a terminal signal, not just a push.
    expect(emits).toContainEqual({ room: `order:${order.id}`, ev: 'dispatch:exhausted' });
    await app.redis.del(`dispatch:exhausts:${order.id}`, `ops_page:dispatch_exhausted:${order.id}`);
  });

  it('ALERTS_LOUD: an offer lands a push-backed notification with expiry; flag off is silent (alerts spec A2)', async () => {
    const quiet = await makeRider({ lat: PICKUP.lat + 0.0045, acceptance: 100 });
    const loud = await makeRider({ lat: PICKUP.lat + 0.02, acceptance: 100 }); // farther: not offered while quiet is online
    try {
      const orderQuiet = await makeDeliveryOrder();
      delete process.env['ALERTS_LOUD'];
      await dispatch.dispatchOrder(orderQuiet.id);
      expect(await app.prisma.notification.count({ where: { userId: quiet.userId } })).toBe(0);

      // Park quiet; with the flag ON the offer goes to loud and must notify.
      await app.prisma.rider.update({ where: { id: quiet.riderId }, data: { isOnline: false } });
      process.env['ALERTS_LOUD'] = '1';
      const orderLoud = await makeDeliveryOrder();
      await dispatch.dispatchOrder(orderLoud.id);
      const note = await app.prisma.notification.findFirst({
        where: { userId: loud.userId },
        orderBy: { createdAt: 'desc' },
      });
      expect(note).toBeTruthy();
      expect(note!.title).toContain('Order available nearby');
      const data = note!.data as { kind: string; orderId: string; expiresAt: string };
      expect(data.kind).toBe('dispatch_offer');
      expect(data.orderId).toBe(orderLoud.id);
      expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      delete process.env['ALERTS_LOUD'];
      // Park this test's riders so later field-geometry tests stay clean.
      await app.prisma.rider.updateMany({
        where: { id: { in: [quiet.riderId, loud.riderId] } },
        data: { isOnline: false },
      });
    }
  });

  it('a stale timeout for a superseded offer is a no-op', async () => {
    const a = await makeRider({ lat: PICKUP.lat + 0.004 });
    const order = await makeDeliveryOrder();
    await dispatch.dispatchOrder(order.id);

    // Timeout fires with the WRONG rider id (offer already superseded)
    await dispatch.handleOfferTimeout(order.id, 'some-other-rider');
    expect((await app.redis.get(`dispatch:offer:${order.id}`))!.split(':')[0]).toBe(a.riderId);

    await app.prisma.rider.update({ where: { id: a.riderId }, data: { isOnline: false } });
  });

  it('widens the radius when the inner ring is empty', async () => {
    const outer = await makeRider({ lat: PICKUP.lat + 0.072 }); // ~8 km — outside 5, inside 10
    const order = await makeDeliveryOrder();

    const result = await dispatch.dispatchOrder(order.id);
    expect(result.offered).toBe(outer.riderId);
    expect(await app.redis.get(`dispatch:round:${order.id}`)).toBe('1');

    await app.prisma.rider.update({ where: { id: outer.riderId }, data: { isOnline: false } });
  });

  it('never dispatches PICKUP orders', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `S8P-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId, vendorId, status: 'ACCEPTED', fulfillment: 'PICKUP',
        deliveryAddress: 'counter', deliveryLat: PICKUP.lat, deliveryLng: PICKUP.lng,
        pickupLat: PICKUP.lat, pickupLng: PICKUP.lng, pickupAddress: 'counter',
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    createdOrderIds.push(order.id);

    const result = await dispatch.dispatchOrder(order.id);
    expect(result).toEqual({});
  });

  it('go-offline releases a held offer: the cascade advances at once and the miss is scored', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } }); // isolate the pool
    const a = await makeRider({ lat: PICKUP.lat + 0.0045, acceptance: 100 }); // best — gets the offer
    const b = await makeRider({ lat: PICKUP.lat + 0.018, acceptance: 100 });  // next in line
    const order = await makeDeliveryOrder();

    const first = await dispatch.dispatchOrder(order.id);
    expect(first.offered).toBe(a.riderId);
    expect((await app.redis.get(`dispatch:mover-offer:${a.riderId}`))!.split(':')[0]).toBe(order.id); // reverse index set [F-014-04 composite]
    // The card RENDERED on A's screen (the app stamps seen on render) — so
    // quitting now is a dodge and MUST cost. An unrendered card would be
    // spared instead [F-014-10 evidence-aware release].
    await dispatch.markOfferSeen(order.id, a.userId);

    // A taps "Go offline" through the REAL route while still holding the live offer.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rider/go-offline',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    // RED before the fix: the offer key stayed pinned on A until the 20 s BullMQ
    // timeout — the cascade never advanced and A's acceptance was never dinged.
    expect((await app.redis.get(`dispatch:offer:${order.id}`))!.split(':')[0]).toBe(b.riderId); // advanced to next mover
    expect(await app.redis.get(`dispatch:mover-offer:${a.riderId}`)).toBeNull(); // reverse index cleared
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, a.riderId)).toBe(1); // won't re-offer A
    const aAfter = await app.prisma.rider.findUniqueOrThrow({ where: { id: a.riderId } });
    expect(aAfter.acceptanceRate).toBeLessThan(100); // miss scored against the quitter

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });

  it('releaseHeldOffer is a safe no-op for a mover holding no live offer (stale/absent pointer)', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.6 }); // far — never offered anything
    const before = (await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } })).acceptanceRate;
    await expect(dispatch.releaseHeldOffer(r.riderId)).resolves.toBeUndefined();
    const after = (await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } })).acceptanceRate;
    expect(after).toBe(before); // nothing scored — they held nothing
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false } });
  });
});

describe('Atomic acceptance — the concurrency proof', () => {
  it('hides and rejects a dual-role rider account claiming its own delivery at both HTTP and DB barriers', async () => {
    const rider = await makeRider({});
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    await app.prisma.order.update({ where: { id: order.id }, data: { customerId: rider.userId } });

    const board = await app.inject({
      method: 'GET',
      url: '/api/v1/rider/orders/available',
      headers: { authorization: `Bearer ${rider.token}` },
    });
    expect(board.statusCode).toBe(200);
    expect((board.json().data as Array<{ id: string }>).map((row) => row.id)).not.toContain(order.id);

    const direct = await app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/accept`,
      payload: {},
      headers: { authorization: `Bearer ${rider.token}`, 'content-type': 'application/json' },
    });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error.code).toBe('SELF_OWN_ORDER');
    await expect(dispatch.claimOrder(order.id, rider.riderId)).rejects.toMatchObject({ code: 'SELF_OWN_ORDER' });

    const durable = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect({ status: durable.status, riderId: durable.riderId }).toEqual({ status: 'READY_FOR_PICKUP', riderId: null });
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false, isAvailable: false } });
  });

  it('rejects a direct claim by a suspended mover and leaves the order open', async () => {
    const rider = await makeRider({});
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    await app.prisma.user.update({ where: { id: rider.userId }, data: { status: 'SUSPENDED' } });

    await expect(dispatch.claimOrder(order.id, rider.riderId)).rejects.toMatchObject({
      code: 'MOVER_INACTIVE',
    });
    const [afterOrder, afterRider] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
    ]);
    expect({ riderId: afterOrder.riderId, status: afterOrder.status }).toEqual({
      riderId: null,
      status: 'READY_FOR_PICKUP',
    });
    expect(afterRider.currentOrderId).toBeNull();
  });

  it('stages the immutable assignment log in the claim transaction and rolls everything back on abort', async () => {
    const rider = await makeRider({});
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    const originalTransaction = app.prisma.$transaction.bind(app.prisma);
    let stagedAssignmentLogs = -1;
    const transaction = vi.spyOn(app.prisma, '$transaction').mockImplementationOnce((async (
      callback: (tx: Parameters<Parameters<typeof app.prisma.$transaction>[0]>[0]) => Promise<unknown>,
      options?: Parameters<typeof app.prisma.$transaction>[1],
    ) => originalTransaction(async (tx) => {
      await callback(tx as Parameters<Parameters<typeof app.prisma.$transaction>[0]>[0]);
      stagedAssignmentLogs = await tx.orderStatusLog.count({
        where: { orderId: order.id, status: 'RIDER_ASSIGNED' },
      });
      throw new Error('forced assignment transaction abort');
    }, options)) as never);

    try {
      await expect(dispatch.claimOrder(order.id, rider.riderId)).rejects.toThrow(
        'forced assignment transaction abort',
      );
    } finally {
      transaction.mockRestore();
    }

    // This observation is made inside the transaction, immediately before the
    // injected failure. Before the fix it was zero because the log was written
    // only after the assignment transaction had already committed.
    expect(stagedAssignmentLogs).toBe(1);
    const [afterOrder, afterRider, committedLogs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'RIDER_ASSIGNED' } }),
    ]);
    expect({ status: afterOrder.status, riderId: afterOrder.riderId }).toEqual({
      status: 'READY_FOR_PICKUP',
      riderId: null,
    });
    expect({
      currentOrderId: afterRider.currentOrderId,
      isAvailable: afterRider.isAvailable,
      committedFloat: Number(afterRider.committedFloat),
    }).toEqual({ currentOrderId: null, isAvailable: true, committedFloat: 0 });
    expect(committedLogs).toBe(0);
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('never re-dispatches a committed winner when journal/rate/Redis/socket/notification publication fails', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false, isAvailable: false } });
    const rider = await makeRider({ lat: PICKUP.lat + 0.001 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(rider.riderId);

    const internals = dispatch as unknown as {
      recordOfferOutcome(moverId: string, accepted: boolean, pool: 'RIDER' | 'DRIVER'): Promise<void>;
      notifications: { riderAssigned: (...args: unknown[]) => Promise<void> };
    };
    const outcome = vi.spyOn(internals, 'recordOfferOutcome').mockRejectedValueOnce(new Error('rate unavailable'));
    const journal = vi.spyOn(app.prisma.dispatchSearch, 'findFirst').mockRejectedValueOnce(new Error('journal unavailable'));
    const redisCleanup = vi.spyOn(app.redis, 'del').mockRejectedValueOnce(new Error('redis unavailable'));
    const socket = vi.spyOn(app.io, 'to').mockImplementationOnce(() => { throw new Error('socket unavailable'); });
    const notification = vi
      .spyOn(internals.notifications, 'riderAssigned')
      .mockRejectedValueOnce(new Error('notification unavailable'));
    const redispatch = vi.spyOn(dispatch, 'dispatchOrder');
    try {
      const accepted = await dispatch.acceptOffer(order.id, rider.userId);
      expect({ status: accepted.status, riderId: accepted.riderId }).toEqual({ status: 'RIDER_ASSIGNED', riderId: rider.riderId });
      expect(redispatch).not.toHaveBeenCalled();
    } finally {
      redispatch.mockRestore();
      notification.mockRestore();
      socket.mockRestore();
      redisCleanup.mockRestore();
      journal.mockRestore();
      outcome.mockRestore();
    }

    const [durableOrder, durableRider, logs] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'RIDER_ASSIGNED' } }),
    ]);
    expect({ status: durableOrder.status, riderId: durableOrder.riderId })
      .toEqual({ status: 'RIDER_ASSIGNED', riderId: rider.riderId });
    expect({ available: durableRider.isAvailable, pointer: durableRider.currentOrderId })
      .toEqual({ available: false, pointer: order.id });
    expect(logs).toBe(1);
  });

  it('10 simultaneous claims on one job: exactly 1 winner, 9 clean rejections', async () => {
    const riders = await Promise.all(Array.from({ length: 10 }, () => makeRider({})));
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const results = await Promise.allSettled(
      riders.map((r) => dispatch.claimOrder(order.id, r.riderId)),
    );

    const wins = results.filter((r) => r.status === 'fulfilled');
    const rejections = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'ALREADY_TAKEN',
    );
    expect(wins).toHaveLength(1);
    expect(rejections).toHaveLength(9);

    const db = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { riderId: true, status: true },
    });
    expect(db.status).toBe('RIDER_ASSIGNED');
    expect(db.riderId).not.toBeNull();

    const logs = await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'RIDER_ASSIGNED' } });
    expect(logs).toBe(1);

    await app.prisma.rider.updateMany({
      where: { id: { in: riders.map((r) => r.riderId) } },
      data: { isOnline: false },
    });
  });

  it('one mover, two live jobs at once: exactly 1 claim wins, the other rolls back open (one-active-job-per-mover)', async () => {
    // The founder's hard invariant: a mover offered two jobs in the same window
    // (two live cards) taps both — must NOT double-book. The claim reserves the
    // MOVER atomically, so the second accept loses and its order stays open.
    const rider = await makeRider({});
    const [orderA, orderB] = await Promise.all([
      makeDeliveryOrder('READY_FOR_PICKUP'),
      makeDeliveryOrder('READY_FOR_PICKUP'),
    ]);

    const results = await Promise.allSettled([
      dispatch.claimOrder(orderA.id, rider.riderId),
      dispatch.claimOrder(orderB.id, rider.riderId),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const busy = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'DRIVER_BUSY',
    );
    expect(wins).toHaveLength(1); // exactly one job claimed
    expect(busy).toHaveLength(1); // the second refused, not double-booked

    const dbRider = await app.prisma.rider.findUniqueOrThrow({
      where: { id: rider.riderId },
      select: { currentOrderId: true, isAvailable: true },
    });
    expect(dbRider.currentOrderId).not.toBeNull();
    expect(dbRider.isAvailable).toBe(false);

    const [a, b] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: orderA.id }, select: { riderId: true, status: true } }),
      app.prisma.order.findUniqueOrThrow({ where: { id: orderB.id }, select: { riderId: true, status: true } }),
    ]);
    // Exactly one order owns the mover; the other rolled back to an open, re-dispatchable state.
    expect([a, b].filter((o) => o.riderId === rider.riderId)).toHaveLength(1);
    const open = [a, b].filter((o) => o.riderId === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe('READY_FOR_PICKUP');

    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { isOnline: false } });
  });

  it('accepting through the HTTP endpoint honours the live offer', async () => {
    const a = await makeRider({ lat: PICKUP.lat + 0.003 });
    const b = await makeRider({ lat: PICKUP.lat + 0.02 });
    const order = await makeDeliveryOrder();

    await dispatch.dispatchOrder(order.id); // offers A

    // B tries to take A's offer -> clean 409
    const stolen = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/offers/accept',
      payload: { orderId: order.id },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
    });
    expect(stolen.statusCode).toBe(409);

    // A accepts -> assigned
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/offers/accept',
      payload: { orderId: order.id },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.status).toBe('RIDER_ASSIGNED');

    // Customer got the rider-assigned notification
    const note = await app.prisma.notification.findFirst({
      where: { userId: customerId, data: { path: ['orderId'], equals: order.id } },
      orderBy: { createdAt: 'desc' },
    });
    expect(note).not.toBeNull();

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });

  it('cannot accept an issued offer after safety or compliance forces the mover offline', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } });
    const a = await makeRider({ lat: PICKUP.lat + 0.003 });
    const b = await makeRider({ lat: PICKUP.lat + 0.02 });
    const order = await makeDeliveryOrder();

    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(a.riderId);
    await app.prisma.rider.update({
      where: { id: a.riderId },
      // Compliance paths can revoke online authority before the advisory Redis
      // offer expires. The DB claim must re-check isOnline at accept time.
      data: { isOnline: false, isAvailable: true },
    });

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/offers/accept',
      payload: { orderId: order.id },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    });
    expect(rejected.statusCode).toBe(409);

    const after = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { riderId: true, status: true },
    });
    expect(after).toEqual({ riderId: null, status: 'ACCEPTED' });
    expect((await app.redis.get(`dispatch:offer:${order.id}`))!.split(':')[0]).toBe(b.riderId);

    await app.prisma.rider.updateMany({
      where: { id: { in: [a.riderId, b.riderId] } },
      data: { isOnline: false },
    });
  });

  it('cannot board-grab an order after safety or compliance forces the rider offline', async () => {
    const rider = await makeRider({});
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    let reachedSeam!: () => void;
    let resumeSeam!: () => void;
    const atSeam = new Promise<void>((resolve) => { reachedSeam = resolve; });
    const resume = new Promise<void>((resolve) => { resumeSeam = resolve; });
    // [REPORT-006 F-006-03] The lock order is now User → orders → riders (the
    // seam locks + reserves the profile row BEFORE the float commit), so the
    // pause point moves to the seam entrance: pausing inside the float commit
    // would hold the already-reserved riders row and deadlock the out-of-band
    // compliance write below. Same subject, same window: the route passed its
    // fast isOnline read, holds only the User lock, and the authoritative
    // reservation CAS has not yet run.
    const originalStage = OrderService.prototype.stageDirectRiderAssignment;
    const stageSpy = vi.spyOn(OrderService.prototype, 'stageDirectRiderAssignment').mockImplementation(async function (
      this: OrderService,
      tx,
      input,
    ) {
      if (input.riderId === rider.riderId) {
        reachedSeam();
        await resume;
      }
      return originalStage.call(this, tx, input);
    });

    let rejected;
    try {
      const pending = app.inject({
        method: 'POST',
        url: `/api/v1/rider/orders/${order.id}/accept`,
        payload: {},
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rider.token}` },
      });
      // The route already passed its fast isOnline read and holds the User lock,
      // but has not touched the order or profile rows. A compliance writer
      // revokes supply here; the authoritative reservation CAS must observe it.
      await atSeam;
      await app.prisma.rider.update({
        where: { id: rider.riderId },
        data: { isOnline: false, isAvailable: true },
      });
      resumeSeam();
      rejected = await pending;
    } finally {
      resumeSeam();
      stageSpy.mockRestore();
    }
    expect(rejected!.statusCode).toBe(409);
    const [afterOrder, afterRider] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
    ]);
    expect({ riderId: afterOrder.riderId, status: afterOrder.status }).toEqual({
      riderId: null,
      status: 'READY_FOR_PICKUP',
    });
    expect(afterRider.currentOrderId).toBeNull();
    expect(Number(afterRider.committedFloat)).toBe(0);
  });

  it('rolls back float, order, rider, status, and audit when the assignment transaction aborts', async () => {
    const rider = await makeRider({});
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    const originalStage = OrderService.prototype.stageDirectRiderAssignment;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageDirectRiderAssignment')
      .mockImplementationOnce(async function (
        this: OrderService,
        tx,
        input,
      ) {
        // Force the failure only AFTER every canonical write (including the
        // immutable audit row) has been staged, but before PostgreSQL commits.
        await originalStage.call(this, tx, input);
        throw new Error('forced pre-commit abort');
      });

    let response;
    try {
      response = await app.inject({
        method: 'POST',
        url: `/api/v1/rider/orders/${order.id}/accept`,
        payload: {},
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rider.token}` },
      });
    } finally {
      stageSpy.mockRestore();
    }
    expect(response!.statusCode).toBe(500);

    const [afterOrder, afterRider, auditCount] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { riderId: true, status: true },
      }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: rider.riderId },
        select: { currentOrderId: true, isAvailable: true, committedFloat: true },
      }),
      app.prisma.orderStatusLog.count({
        where: { orderId: order.id, status: 'RIDER_ASSIGNED' },
      }),
    ]);
    expect(afterOrder).toEqual({ riderId: null, status: 'READY_FOR_PICKUP' });
    expect(afterRider.currentOrderId).toBeNull();
    expect(afterRider.isAvailable).toBe(true);
    expect(Number(afterRider.committedFloat)).toBe(0);
    expect(auditCount).toBe(0);
  });

  it('two riders racing the DIRECT accept endpoint: exactly one wins, the loser is not stuck busy', async () => {
    // POST /rider/orders/:id/accept used a plain update-by-id, so two riders who
    // both passed the JS riderId-null check could double-assign AND both mark
    // themselves busy. This proves the compare-and-set fix.
    const a = await makeRider({ lat: PICKUP.lat + 0.003 });
    const b = await makeRider({ lat: PICKUP.lat + 0.004 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const accept = (token: string) => app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/accept`,
      payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    const [ra, rb] = await Promise.all([accept(a.token), accept(b.token)]);

    // Exactly one winner (200), one clean conflict (409) — never two winners.
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { riderId: true, status: true } });
    expect(db.status).toBe('RIDER_ASSIGNED');
    expect([a.riderId, b.riderId]).toContain(db.riderId);
    expect(await app.prisma.orderStatusLog.count({
      where: { orderId: order.id, status: 'RIDER_ASSIGNED' },
    })).toBe(1);

    // Only the winner is busy on this order; the loser is free, not stranded.
    const riders = await app.prisma.rider.findMany({ where: { id: { in: [a.riderId, b.riderId] } }, select: { id: true, currentOrderId: true } });
    const busyOnThis = riders.filter((r) => r.currentOrderId === order.id);
    expect(busyOnThis).toHaveLength(1);
    expect(busyOnThis[0]!.id).toBe(db.riderId);

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });

  // D.3 cash-exposure parity [debug-ledger P2]: the offer cascade gates
  // candidates on float headroom and commits float on claim — the DIRECT
  // board-grab accept must do the same, or the cash-exposure cap is
  // bypassable through this entrance and a later release decrements float
  // that was never committed.
  it('direct accept REFUSES a CASH order beyond the rider float headroom', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.003 });
    // Order fronts 2,000 GYD of vendor cash; the rider only has 1,000 headroom.
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { floatLimit: 1000, committedFloat: 0 } });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/accept`,
      payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('FLOAT_EXCEEDED');

    // Nothing claimed, rider not stuck.
    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { riderId: true } });
    expect(db.riderId).toBeNull();

    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, floatLimit: 1_000_000 } });
  });

  it('direct accept COMMITS the CASH float, mirroring dispatch.claimOrder', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.003 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/accept`,
      payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    });
    expect(res.statusCode).toBe(200);

    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId }, select: { committedFloat: true } });
    expect(Number(rider.committedFloat)).toBe(2000); // = the order's subtotalBase

    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, committedFloat: 0, currentOrderId: null, isAvailable: true },
    });
  });

  it('one rider grabbing TWO cash orders at once cannot exceed the float cap [SWIFT-104]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.003 });
    // Headroom 3,000; each order fronts 2,000 — either fits ALONE, both do NOT.
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { floatLimit: 3000, committedFloat: 0 } });

    // SWIFT-104's real subject: the guarded ATOMIC increment. Two concurrent
    // commits both read headroom 3,000; a read-then-write would let both pass.
    // Exactly one may win, and the cap must hold with no order machinery at all.
    const float = new FloatService(app.prisma);
    const [c1, c2] = await Promise.all([
      float.commit(app.prisma, r.riderId, 2000),
      float.commit(app.prisma, r.riderId, 2000),
    ]);
    expect([c1, c2].filter(Boolean)).toHaveLength(1);
    const mid = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId }, select: { committedFloat: true } });
    expect(Number(mid.committedFloat)).toBe(2000);
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { committedFloat: 0 } });

    // Integration shape [REPORT-006 F-006-03]: with the unified User → orders
    // → riders lock order, two same-rider grabs SERIALIZE on the User lock and
    // the loser now fails the one-live-job reservation CAS (409) before the
    // float gate can bind — the cap invariant holds either way: float is
    // committed exactly once and exactly one order is assigned.
    const orderA = await makeDeliveryOrder('READY_FOR_PICKUP');
    const orderB = await makeDeliveryOrder('READY_FOR_PICKUP');
    const accept = (orderId: string) => app.inject({
      method: 'POST', url: `/api/v1/rider/orders/${orderId}/accept`, payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    });
    const [ra, rb] = await Promise.all([accept(orderA.id), accept(orderB.id)]);

    // Exactly one winner; the loser is refused (busy reservation or float —
    // whichever predicate its serialized turn hits first) — never two.
    expect([ra, rb].filter((x) => x.statusCode === 200)).toHaveLength(1);
    const loser = [ra, rb].find((x) => x.statusCode !== 200)!;
    expect([400, 409]).toContain(loser.statusCode);

    // The cap HELD: float committed exactly once (2,000, not 4,000).
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId }, select: { committedFloat: true } });
    expect(Number(after.committedFloat)).toBe(2000);

    // One order assigned to the rider; the other is back on the board (compensated).
    const orders = await app.prisma.order.findMany({ where: { id: { in: [orderA.id, orderB.id] } }, select: { riderId: true } });
    expect(orders.filter((o) => o.riderId === r.riderId)).toHaveLength(1);
    expect(orders.filter((o) => o.riderId === null)).toHaveLength(1);

    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, committedFloat: 0, currentOrderId: null, isAvailable: true, floatLimit: 1_000_000 },
    });
  });

  it('a DELIVERY-only rider cannot board-grab a COURIER parcel; a BOTH rider can [REPORT-014 F-014-08]', async () => {
    const courier = await app.prisma.order.create({
      data: {
        orderNumber: `SVC-${nanoid(10)}`, orderType: 'COURIER', customerId, status: 'READY_FOR_PICKUP',
        fulfillment: 'DELIVERY', courierPackageSize: 'SMALL',
        pickupAddress: 'x', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
        deliveryAddress: 'y', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 700, totalAmount: 700, paymentMethod: 'CASH',
      },
    });
    createdOrderIds.push(courier.id);

    const deliveryOnly = await makeRider({ lat: PICKUP.lat + 0.002 }); // riderType DELIVERY
    const refused = await app.inject({
      method: 'POST', url: `/api/v1/rider/orders/${courier.id}/accept`,
      headers: { authorization: `Bearer ${deliveryOnly.token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('WRONG_SERVICE_TYPE');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: courier.id } })).riderId).toBeNull();

    // A BOTH rider serves it.
    const both = await makeRider({ lat: PICKUP.lat + 0.003 });
    await app.prisma.rider.update({ where: { id: both.riderId }, data: { riderType: 'BOTH' } });
    const ok = await app.inject({
      method: 'POST', url: `/api/v1/rider/orders/${courier.id}/accept`,
      headers: { authorization: `Bearer ${both.token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    await app.prisma.order.update({ where: { id: courier.id }, data: { riderId: null, status: 'READY_FOR_PICKUP' } });
    for (const rid of [deliveryOnly.riderId, both.riderId]) {
      await app.prisma.rider.update({ where: { id: rid }, data: { isOnline: false, isAvailable: true, currentOrderId: null, committedFloat: 0 } });
    }
  });

  it('a BOARD grab retires the live Redis offer and finalizes the search journal [REPORT-014 F-014-09]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.013 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    // Simulate the state left when this order also had a live offer out and a
    // SEARCHING journal open — the board grab used to leave both alive.
    await app.redis.set(`dispatch:offer:${order.id}`, r.riderId, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${r.riderId}`, order.id, 'EX', 40);
    await app.prisma.dispatchSearch.create({
      data: { subjectId: order.id, subjectType: 'ORDER', status: 'SEARCHING', startedAt: new Date(), vertical: 'DELIVERY', radiusKm: 3 },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/rider/orders/${order.id}/accept`,
      headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    // Redis offer pair retired → a stale timeout can no longer penalize the rider.
    expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBeNull();
    expect(await app.redis.get(`dispatch:mover-offer:${r.riderId}`)).toBeNull();
    // Journal resolved, not left SEARCHING forever.
    const journal = await app.prisma.dispatchSearch.findFirst({ where: { subjectId: order.id }, orderBy: { startedAt: 'desc' } });
    expect(journal?.status).toBe('ASSIGNED');
    expect(journal?.assignedTo).toBe(r.riderId);

    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: order.id } });
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: null, status: 'READY_FOR_PICKUP' } });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: true, currentOrderId: null, committedFloat: 0 } });
  });

  it('the BOARD accept route also rejects fare 0 as a floor-clamp — market rate applies [REPORT-011 F-04]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.011 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    const marketFee = Number((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { deliveryFee: true } })).deliveryFee);
    // The open-board grab (/orders/:id/accept), not the offer card — a forged
    // or legacy client posting fare 0 must not clamp the rider's own pay down.
    const res = await app.inject({
      method: 'POST', url: `/api/v1/rider/orders/${order.id}/accept`,
      headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' },
      payload: { fare: 0 },
    });
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBe(r.riderId);
    expect(Number(fresh.deliveryFee)).toBe(marketFee); // untouched — 0 meant no choice
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: null, status: 'READY_FOR_PICKUP' } });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: true, currentOrderId: null, committedFloat: 0 } });
  });

  it('accepting with fare 0 means NO price choice — the market rate applies, never the 60% floor [REPORT-010 F-07]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.01 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP'); // CASH, market fee from fixture
    const marketFee = Number((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { deliveryFee: true } })).deliveryFee);
    await app.redis.set(`dispatch:offer:${order.id}`, r.riderId, 'EX', 40);
    // A recovered card whose board row never loaded used to submit fare: 0 —
    // silently clamping the rider's pay to the 60% floor.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rider/offers/accept',
      headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' },
      payload: { orderId: order.id, fare: 0 },
    });
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBe(r.riderId);
    expect(Number(fresh.deliveryFee)).toBe(marketFee); // pay untouched — zero meant "no choice"
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: null, status: 'READY_FOR_PICKUP' } });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: true, currentOrderId: null, committedFloat: 0 } });
    await app.redis.del(`dispatch:offer:${order.id}`, `dispatch:mover-offer:${r.riderId}`);
  });

  it('a positive fare on an MMG offer is neutralized BEFORE the offer is consumed — the mover still wins at the locked price [REPORT-012 F-012-02]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.012 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    await app.prisma.order.update({
      where: { id: order.id },
      data: { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' },
    });
    const before = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id }, select: { deliveryFee: true, totalAmount: true },
    });
    await app.redis.set(`dispatch:offer:${order.id}`, r.riderId, 'EX', 40);
    // A stale/forged client undercuts the locked MMG price. Before this fix
    // the fare rode into claimOrder and was rejected MMG_PRICE_LOCKED — but
    // removeOfferIfOwned had already destroyed the offer, and the catch
    // marked THIS mover declined and advanced the cascade: a valid offer
    // burned. Neutralized pre-consumption, the accept now succeeds at the
    // locked market price.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rider/offers/accept',
      headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' },
      payload: { orderId: order.id, fare: 300 },
    });
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBe(r.riderId); // the mover WON — never declined
    expect(fresh.status).toBe('RIDER_ASSIGNED');
    expect(Number(fresh.deliveryFee)).toBe(Number(before.deliveryFee)); // locked price untouched
    expect(Number(fresh.totalAmount)).toBe(Number(before.totalAmount)); // captured money unchanged
    // The cascade never advanced past the winner: no self-decline recorded.
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, r.riderId)).toBe(0);
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: null, status: 'READY_FOR_PICKUP' } });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: true, currentOrderId: null, committedFloat: 0 } });
    await app.redis.del(`dispatch:offer:${order.id}`, `dispatch:mover-offer:${r.riderId}`);
  });

  it('an UNRENDERED offer that times out never decays the acceptance rate; a SEEN one does [danger #21]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.009 });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { acceptanceRate: 100 } });

    // Ping 1: the network eats it — no render proof ever lands.
    const order1 = await makeDeliveryOrder('READY_FOR_PICKUP');
    await app.redis.set(`dispatch:offer:${order1.id}`, r.riderId, 'EX', 40);
    await app.prisma.alertDelivery.create({
      data: { kind: 'MOVER_OFFER', subjectId: order1.id, recipientId: r.userId },
    });
    await dispatch.handleOfferTimeout(order1.id, r.riderId);
    const afterUnseen = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(Number(afterUnseen.acceptanceRate)).toBe(100); // spared — provably never saw it
    // The cascade still advanced honestly: the mover is in the declined set.
    expect(await app.redis.sismember(`dispatch:declined:${order1.id}`, r.riderId)).toBe(1);

    // Ping 2: the card RENDERED (client stamped seen) — ignoring it costs.
    const order2 = await makeDeliveryOrder('READY_FOR_PICKUP');
    await app.redis.set(`dispatch:offer:${order2.id}`, r.riderId, 'EX', 40);
    await app.prisma.alertDelivery.create({
      data: { kind: 'MOVER_OFFER', subjectId: order2.id, recipientId: r.userId },
    });
    await dispatch.markOfferSeen(order2.id, r.userId);
    await dispatch.handleOfferTimeout(order2.id, r.riderId);
    const afterSeen = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(Number(afterSeen.acceptanceRate)).toBe(80); // 100·0.8 + 0·0.2 — the EMA applied once

    await app.prisma.alertDelivery.deleteMany({ where: { subjectId: { in: [order1.id, order2.id] } } });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: true, currentOrderId: null } });
  });

  it('concurrent dispatch triggers install exactly ONE offer — losers emit nothing [E29 / danger #18]', async () => {
    const r1 = await makeRider({ lat: PICKUP.lat + 0.006 });
    const r2 = await makeRider({ lat: PICKUP.lat + 0.007 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    // Fire the SAME trigger twice concurrently (route retry + queue job, two
    // instances, double webhook — all real shapes). The old plain SET let the
    // second run STEAL the first mover's offer and duplicate the card/push/
    // journal; NX makes the install the mutual exclusion.
    const [a, b] = await Promise.all([
      dispatch.dispatchOrder(order.id),
      dispatch.dispatchOrder(order.id),
    ]);
    // Exactly one live offer key, owned by ONE mover; both calls REPORT the
    // same owner (the loser returns the winner's offer, never a second card).
    const owner = await app.redis.get(`dispatch:offer:${order.id}`);
    expect(owner).toBeTruthy();
    const ownerId = owner!.split(':')[0]; // `<mover>:<attemptId>` [F-014-04]
    expect(a.offered).toBe(ownerId);
    expect(b.offered).toBe(ownerId);
    // Exactly one alert-delivery row: the loser emitted nothing.
    const pings = await app.prisma.alertDelivery.count({ where: { subjectId: order.id, kind: 'MOVER_OFFER' } });
    expect(pings).toBe(1);
    await app.redis.del(`dispatch:offer:${order.id}`, `dispatch:mover-offer:${ownerId}`);
    for (const r of [r1, r2]) {
      await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: true, currentOrderId: null } });
    }
  });

  it('a reconnecting mover recovers their live offer with real remaining seconds [E27 / danger #37]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.008 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');
    // Install the exclusive offer exactly as the cascade does (the cascade
    // itself is proven elsewhere) — under test here is the RECOVERY read.
    await app.redis.set(`dispatch:offer:${order.id}`, r.riderId, 'EX', 40);
    await app.redis.set(`dispatch:mover-offer:${r.riderId}`, order.id, 'EX', 40);

    // The socket that carried the card is gone — the recovery read rebuilds it.
    const offer = await dispatch.currentOfferFor(r.riderId);
    expect(offer).not.toBeNull();
    expect(offer!.orderId).toBe(order.id);
    expect(offer!.orderNumber).toBe(order.orderNumber);
    expect(offer!.expiresInSeconds).toBeGreaterThan(0);

    // Ownership is authoritative, not the advisory reverse pointer: once the
    // offer key belongs to someone else, recovery reports gone.
    await app.redis.set(`dispatch:offer:${order.id}`, 'someone-else', 'EX', 60);
    expect(await dispatch.currentOfferFor(r.riderId)).toBeNull();

    await app.redis.del(`dispatch:offer:${order.id}`, `dispatch:mover-offer:${r.riderId}`);
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: true, currentOrderId: null } });
  });

  it('a stale offer cannot commit float past the cap after the basket grew [REPORT-007-v4 F-01]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.005 });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { floatLimit: 2000, committedFloat: 0 } });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP'); // subtotal 2000 — exactly at the cap at OFFER time
    // A substitution approved while the Redis offer sat live makes the basket
    // dearer; the rider is unassigned so no float adjusts yet (correct).
    await app.prisma.order.update({
      where: { id: order.id },
      data: { subtotalBase: { increment: 200 }, subtotalCustomer: { increment: 200 }, totalAmount: { increment: 200 } },
    });
    // Acceptance re-reads the LIVE subtotal and must run it through the
    // guarded commit — the old inline increment blindly pushed committedFloat
    // to 2,200 past the 2,000 hard cap and kept the assignment.
    await expect(dispatch.claimOrder(order.id, r.riderId, 'RIDER')).rejects.toMatchObject({ code: 'FLOAT_EXCEEDED' });
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBeNull(); // the whole claim rolled back
    expect(fresh.status).toBe('READY_FOR_PICKUP');
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(Number(after.committedFloat)).toBe(0);
    expect(after.currentOrderId).toBeNull();

    // Exactly-at-cap still claims — the guard is headroom >= amount.
    const order2 = await makeDeliveryOrder('READY_FOR_PICKUP');
    await dispatch.claimOrder(order2.id, r.riderId, 'RIDER');
    expect(Number((await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } })).committedFloat)).toBe(2000);
    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, committedFloat: 0, currentOrderId: null, isAvailable: true, floatLimit: 1_000_000 },
    });
  });

  it('an offer claim refuses an unpaid MMG order and writes nothing [SPS-F-0016 / REPORT-004 F-004-01]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.004 });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `MM-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId,
        status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY',
        pickupAddress: 'Vendor HQ', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
        deliveryAddress: 'Customer place', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
        // paymentStatus defaults PENDING — the legacy in-flight shape the gate must refuse.
        paymentMethod: 'MOBILE_MONEY',
      },
    });
    createdOrderIds.push(order.id);
    await expect(dispatch.claimOrder(order.id, r.riderId, 'RIDER')).rejects.toMatchObject({ code: 'MMG_PAYMENT_PENDING' });
    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.riderId).toBeNull();
    expect(fresh.status).toBe('READY_FOR_PICKUP');
    // Park this rider so later nearest-N candidate assertions don't count it.
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: false } });
  });

  it('one rider grabbing two MOBILE_MONEY orders at once cannot double-book — the float gate does not apply [one-job-per-mover]', async () => {
    // MOBILE_MONEY fronts no cash, so floatAmt=0 and the SWIFT-104 float commit
    // never fires — the ONLY thing stopping one rider from winning two different
    // orders concurrently is the rider-reserve compare-and-set. (Two small CASH
    // orders under the cap have the same hole; MOBILE_MONEY is the sharpest case.)
    const r = await makeRider({ lat: PICKUP.lat + 0.004 });
    const mk = () =>
      app.prisma.order
        .create({
          data: {
            orderNumber: `MM-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId,
            status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY',
            pickupAddress: 'Vendor HQ', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
            deliveryAddress: 'Customer place', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
            subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
            // CAPTURED: the payment-first law [SPS-F-0016] only lets a rider
            // claim an MMG order after the store confirmed the payment — the
            // one-job-per-mover race under test happens post-confirmation.
            paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED',
          },
        })
        .then((o) => { createdOrderIds.push(o.id); return o; });
    const [orderA, orderB] = await Promise.all([mk(), mk()]);

    const accept = (orderId: string) => app.inject({
      method: 'POST', url: `/api/v1/rider/orders/${orderId}/accept`, payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    });
    const [ra, rb] = await Promise.all([accept(orderA.id), accept(orderB.id)]);

    // Exactly one winner — never two. The loser is a clean 409 conflict, not a 500.
    expect([ra, rb].filter((x) => x.statusCode === 200)).toHaveLength(1);
    const loser = [ra, rb].find((x) => x.statusCode !== 200)!;
    expect(loser.statusCode).toBe(409);

    // The rider holds exactly ONE order; the other is back on the board (riderId null).
    const orders = await app.prisma.order.findMany({ where: { id: { in: [orderA.id, orderB.id] } }, select: { id: true, riderId: true } });
    const mine = orders.filter((o) => o.riderId === r.riderId);
    expect(mine).toHaveLength(1);
    expect(orders.filter((o) => o.riderId === null)).toHaveLength(1);
    // currentOrderId points at exactly that one order — not left double-booked.
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId }, select: { currentOrderId: true } });
    expect(after.currentOrderId).toBe(mine[0]!.id);

    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, committedFloat: 0, currentOrderId: null, isAvailable: true },
    });
  });
});

describe('Account-status authority', () => {
  it('linearizes GO against suspension and always leaves suspended supply offline', async () => {
    const rider = await makeRider({ online: false, available: false });
    const [go, suspension] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/rider/go-online',
        payload: { latitude: 6.8234, longitude: -58.1678 },
        headers: { authorization: `Bearer ${rider.token}` },
      }),
      transitionUserStatusAuthority(app, rider.userId, 'SUSPENDED'),
    ]);
    expect([200, 401, 403]).toContain(go.statusCode);
    expect(suspension.updated.status).toBe('SUSPENDED');
    const [user, profile] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: rider.userId } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
    ]);
    expect(user.status).toBe('SUSPENDED');
    expect({ online: profile.isOnline, available: profile.isAvailable })
      .toEqual({ online: false, available: false });
  });

  it('blocks GO for a pending-verification account at the locked earning gate', async () => {
    const rider = await makeRider({ online: false, available: false });
    await app.prisma.user.update({
      where: { id: rider.userId },
      data: { status: 'PENDING_VERIFICATION' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/go-online',
      payload: { latitude: 6.8234, longitude: -58.1678 },
      headers: { authorization: `Bearer ${rider.token}` },
    });
    expect(response.statusCode).toBe(403);
    const profile = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect({ online: profile.isOnline, available: profile.isAvailable })
      .toEqual({ online: false, available: false });
  });

  it('suspends idle dual-profile supply atomically and unsuspends without restoring it', async () => {
    const rider = await makeRider({});
    const driver = await app.prisma.driver.create({
      data: {
        userId: rider.userId,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
        vehicleColor: 'Silver', licensePlate: `STATUS-${seq}`,
        driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', documentsVerified: true,
        isOnline: true, isAvailable: true,
        currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
      },
    });

    await transitionUserStatusAuthority(app, rider.userId, 'SUSPENDED');
    let [user, afterRider, afterDriver] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: rider.userId } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }),
    ]);
    expect(user.status).toBe('SUSPENDED');
    expect([afterRider.isOnline, afterRider.isAvailable, afterDriver.isOnline, afterDriver.isAvailable])
      .toEqual([false, false, false, false]);

    await transitionUserStatusAuthority(app, rider.userId, 'ACTIVE');
    [user, afterRider, afterDriver] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: rider.userId } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }),
    ]);
    expect(user.status).toBe('ACTIVE');
    expect([afterRider.isOnline, afterRider.isAvailable, afterDriver.isOnline, afterDriver.isAvailable])
      .toEqual([false, false, false, false]);
  });

  it('refuses suspension or ban while a mover owns an active job', async () => {
    const rider = await makeRider({});
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { currentOrderId: 'status-active-job', isOnline: true, isAvailable: false },
    });

    await expect(transitionUserStatusAuthority(app, rider.userId, 'SUSPENDED'))
      .rejects.toMatchObject({ code: 'ACTIVE_JOB' });
    await expect(transitionUserStatusAuthority(app, rider.userId, 'BANNED'))
      .rejects.toMatchObject({ code: 'ACTIVE_JOB' });
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: rider.userId } })).status)
      .toBe('ACTIVE');
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { currentOrderId: null, isOnline: false, isAvailable: false },
    });
  });

  it('makes ban terminal under a concurrent suspend and revokes every session', async () => {
    const rider = await makeRider({});
    const outcomes = await Promise.allSettled([
      transitionUserStatusAuthority(app, rider.userId, 'SUSPENDED'),
      transitionUserStatusAuthority(app, rider.userId, 'BANNED'),
    ]);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: rider.userId } });
    expect(user.status).toBe('BANNED');
    expect(await app.prisma.session.count({ where: { userId: rider.userId } })).toBe(0);
    await expect(transitionUserStatusAuthority(app, rider.userId, 'SUSPENDED'))
      .rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: rider.userId } })).status)
      .toBe('BANNED');
  });

  it('does not turn pending verification into ACTIVE through suspend/unsuspend', async () => {
    const rider = await makeRider({});
    await app.prisma.user.update({
      where: { id: rider.userId },
      data: { status: 'PENDING_VERIFICATION' },
    });
    await expect(transitionUserStatusAuthority(app, rider.userId, 'SUSPENDED'))
      .rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: rider.userId } })).status)
      .toBe('PENDING_VERIFICATION');
  });
});

describe('candidate selection at scale [SWIFT-142]', () => {
  it('with >50 movers in range, the pool is the NEAREST 50 — not an arbitrary 50', async () => {
    // Isolate the pool: take every other test's residual riders offline first.
    await app.prisma.rider.updateMany({ data: { isOnline: false } });

    const nearIds: string[] = [];
    const farIds: string[] = [];
    const localUserIds: string[] = [];
    const phoneBase = 592_800_000_000 + Math.floor(Math.random() * 90_000_000);
    let n = 0;
    const mk = async (lat: number, lng: number, bucket: string[]) => {
      n += 1;
      const u = await app.prisma.user.create({
        data: { phone: `+${phoneBase + n}`, firstName: 'Cand', lastName: `${n}`, roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER', isPhoneVerified: true },
      });
      const session = await app.prisma.session.create({
        data: {
          userId: u.id,
          token: `candidate-${nanoid(24)}`,
          refreshToken: nanoid(48),
          deviceId: `candidate-${n}`,
          deviceType: 'test',
          expiresAt: new Date(Date.now() + DAY),
        },
      });
      const r = await app.prisma.rider.create({
        data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, isAvailable: true, currentLat: lat, currentLng: lng, lastLocationUpdate: new Date(), locationSessionId: session.id, floatLimit: 1_000_000, committedFloat: 0 },
      });
      bucket.push(r.id);
      localUserIds.push(u.id);
    };
    // FAR first, then NEAR — so nothing but the ORDER BY puts the near ones in
    // the pool (insertion order alone would keep the far ones). 20 FAR (~4.8 km,
    // still inside the 5 km radius) + 50 NEAR (≤ ~555 m): any 50-of-70 that isn't
    // distance-ordered admits far riders and drops near ones.
    for (let i = 0; i < 20; i += 1) await mk(PICKUP.lat + 0.043, PICKUP.lng + 0.00001 * i, farIds);
    for (let i = 0; i < 50; i += 1) await mk(PICKUP.lat + 0.0001 * (i + 1), PICKUP.lng, nearIds);

    try {
      const candidates = await dispatch.findCandidates(`s142-${nanoid(6)}`, PICKUP, 5, 'RIDER', 0, null);
      const ids = new Set(candidates.map((c) => (c as { riderId: string }).riderId));
      expect(candidates.length).toBeLessThanOrEqual(50);
      // Every NEAR rider made the cut...
      expect(nearIds.every((id) => ids.has(id))).toBe(true);
      // ...and no FAR rider did. (Pre-fix, an arbitrary 50 of the 55 in range
      // would almost surely drop a near rider and admit a far one.)
      expect(farIds.some((id) => ids.has(id))).toBe(false);
    } finally {
      await app.prisma.rider.deleteMany({ where: { id: { in: [...nearIds, ...farIds] } } });
      await app.prisma.user.deleteMany({ where: { id: { in: localUserIds } } });
    }
  });

  it('the straight-line candidate cap is tunable (DISPATCH_NEAREST_CANDIDATE_CAP) and keeps the NEAREST N', async () => {
    // Remote spot far from every other fixture (no other rider is within 5 km),
    // so we DON'T need a global updateMany to isolate the pool — which avoids
    // contaminating the other test files running in parallel. makeRider uses the
    // file's own +59200088 phone prefix (auto-purged, no cross-file collision).
    const SPOT = { lat: 6.20, lng: -57.50 };
    const riders: Array<{ id: string; d: number }> = [];
    for (let i = 1; i <= 6; i += 1) {
      const r = await makeRider({ lat: SPOT.lat + 0.001 * i, lng: SPOT.lng }); // ~111 m .. ~666 m out
      riders.push({ id: r.riderId, d: i });
    }

    const prev = process.env['DISPATCH_NEAREST_CANDIDATE_CAP'];
    process.env['DISPATCH_NEAREST_CANDIDATE_CAP'] = '3';
    try {
      const candidates = await dispatch.findCandidates(`cap-${nanoid(6)}`, SPOT, 5, 'RIDER', 0, null);
      // RED before the fix: the cap was a hardcoded 50 — all 6 came back.
      expect(candidates.length).toBe(3);
      const ids = new Set(candidates.map((c) => (c as { riderId: string }).riderId));
      const byDistance = [...riders].sort((a, b) => a.d - b.d);
      expect(byDistance.slice(0, 3).every((r) => ids.has(r.id))).toBe(true);   // nearest 3 kept
      expect(byDistance.slice(3).some((r) => ids.has(r.id))).toBe(false);      // farthest 3 truncated
    } finally {
      if (prev === undefined) delete process.env['DISPATCH_NEAREST_CANDIDATE_CAP'];
      else process.env['DISPATCH_NEAREST_CANDIDATE_CAP'] = prev;
      // Park them (afterAll's purgeFixtures deletes the +59200088 users by phone).
      await app.prisma.rider.updateMany({ where: { id: { in: riders.map((r) => r.id) } }, data: { isOnline: false } });
    }
  });
});

describe('vehicle capability matching [SWIFT-062]', () => {
  it('an EXTRA_LARGE parcel is offered to a CAR, never to a bicycle', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } });
    const localUserIds: string[] = [];
    const phoneBase = 592_830_000_000 + Math.floor(Math.random() * 80_000_000);
    let n = 0;
    const mkVeh = async (veh: 'BICYCLE' | 'MOTORCYCLE' | 'CAR') => {
      n += 1;
      const u = await app.prisma.user.create({ data: { phone: `+${phoneBase + n}`, firstName: 'Veh', lastName: `${n}`, roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER', isPhoneVerified: true } });
      const session = await app.prisma.session.create({
        data: {
          userId: u.id,
          token: `vehicle-${nanoid(24)}`,
          refreshToken: nanoid(48),
          deviceId: `vehicle-${n}`,
          deviceType: 'test',
          expiresAt: new Date(Date.now() + DAY),
        },
      });
      const r = await app.prisma.rider.create({ data: { userId: u.id, riderType: 'BOTH', vehicleType: veh, documentsVerified: true, isOnline: true, isAvailable: true, currentLat: PICKUP.lat + 0.001, currentLng: PICKUP.lng, lastLocationUpdate: new Date(), locationSessionId: session.id, floatLimit: 1_000_000, committedFloat: 0 } });
      localUserIds.push(u.id);
      return r.id;
    };
    const bike = await mkVeh('BICYCLE');
    const car = await mkVeh('CAR');
    try {
      const xl = new Set((await dispatch.findCandidates(`s62-xl-${nanoid(6)}`, PICKUP, 5, 'RIDER', 0, null, null, 'EXTRA_LARGE')).map((c) => (c as { riderId: string }).riderId));
      expect(xl.has(car)).toBe(true);
      expect(xl.has(bike)).toBe(false); // a bicycle can't carry a wardrobe box

      // A SMALL parcel fits any vehicle — both are eligible.
      const sm = new Set((await dispatch.findCandidates(`s62-sm-${nanoid(6)}`, PICKUP, 5, 'RIDER', 0, null, null, 'SMALL')).map((c) => (c as { riderId: string }).riderId));
      expect(sm.has(car)).toBe(true);
      expect(sm.has(bike)).toBe(true);
    } finally {
      await app.prisma.rider.deleteMany({ where: { userId: { in: localUserIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: localUserIds } } });
    }
  });
});
