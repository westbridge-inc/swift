import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { makeDispatchService } from '../modules/dispatch/dispatch.service';
import { NotificationService } from '../modules/notification/notification.service';
import { scanSupplyWatches } from '../modules/dispatch/supply-watch.service';

// ---------------------------------------------------------------------------
// Supply watcher (availability §5): watch → scan silent while empty → drivers
// return → ONE notification, stamped, never repeated.
// ---------------------------------------------------------------------------

// Another remote spot, away from every other suite's field.
const SPOT = { lat: 8.11, lng: -59.72 };

let app: FastifyInstance;
let token: string;
let customerId: string;
const userIds: string[] = [];
const driverIds: string[] = [];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();

  const me = await app.prisma.user.create({
    data: {
      phone: `+59255${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Watch', lastName: 'Er',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  customerId = me.id;
  userIds.push(me.id);
  token = app.jwt.sign({ userId: me.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: me.id, token, refreshToken: nanoid(48),
      deviceId: 'watch-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
});

afterAll(async () => {
  await app.prisma.supplyWatch.deleteMany({ where: { customerId: { in: userIds } } });
  if (driverIds.length > 0) await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  if (userIds.length > 0) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('supply watcher', () => {
  it('registers a watch, stays silent while empty, notifies ONCE when a driver returns', async () => {
    // Register the watch through the real endpoint.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rides/availability/watch',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: SPOT,
    });
    expect(res.statusCode).toBe(200);

    const dispatch = makeDispatchService(app as never);
    const notifications = new NotificationService(app.prisma, app.io);

    // Empty field: scan notifies nobody, watch stays open.
    expect(await scanSupplyWatches(app.prisma, dispatch, notifications)).toBe(0);

    // A driver comes online in range.
    const du = await app.prisma.user.create({
      data: {
        phone: `+59254${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'Back', lastName: 'Online',
        roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
        isPhoneVerified: true,
      },
    });
    userIds.push(du.id);
    const d = await app.prisma.driver.create({
      data: {
        userId: du.id,
        vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2021, vehicleColor: 'Yellow',
        licensePlate: `SW${nanoid(5)}`,
        driverLicenseUrl: '/uploads/t.jpg', vehicleInsuranceUrl: '/uploads/t.jpg',
        isOnline: true, isAvailable: true, documentsVerified: true,
        rideClass: 'ECONOMY' as never,
        currentLat: SPOT.lat + 0.004, currentLng: SPOT.lng,
      },
    });
    driverIds.push(d.id);

    // First scan with supply: exactly one notification, watch stamped.
    expect(await scanSupplyWatches(app.prisma, dispatch, notifications)).toBe(1);
    const note = await app.prisma.notification.findFirstOrThrow({
      where: { userId: customerId },
      orderBy: { createdAt: 'desc' },
    });
    expect(note.title).toContain('Drivers are back');

    // Second scan: nothing left to notify.
    expect(await scanSupplyWatches(app.prisma, dispatch, notifications)).toBe(0);
    expect(await app.prisma.notification.count({ where: { userId: customerId } })).toBe(1);
  });
});
