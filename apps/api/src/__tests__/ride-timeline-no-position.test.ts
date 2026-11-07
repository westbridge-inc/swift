import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { gpsEvidence } from '../modules/cash/cash-rules.service';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [REVIEW-F S4-2 on #2055] A mover's step note carries the server's position
// evidence (" — gps:LAT,LNG …" or " — no GPS fix on file"), kept for support
// and appeals. The customer's order view already cuts it (customerTimeline);
// the passenger's own ride, GET /rides/:id, still returned the raw notes, so a
// passenger read the driver's recorded coordinates. The ride's timeline now
// goes through the same cut. Every other field of a row is unchanged (the
// shape old builds read), and a note without evidence is returned as written.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const GT = { lat: 6.8013, lng: -58.1553 };
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:ride-timeline-no-position');

let app: FastifyInstance;
const userIds: string[] = [];

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Ride', lastName: `Timeline${userIds.length}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    } as never,
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ride-timeline-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

describe('[REVIEW-F S4-2 on #2055] the passenger\'s ride timeline never carries the driver\'s recorded position', () => {
  it('GET /rides/:id cuts the position evidence from every note and keeps the rest of each row', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const ride = await sys(() => app.prisma.order.create({
      data: {
        orderNumber: `RT-${nanoid(6)}`, orderType: 'TAXI', customerId: passenger.userId, status: 'RIDE_IN_PROGRESS',
        pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng, deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
      } as never,
    }));
    const notes = [
      'Ride requested — fixed fare $1500',
      `Driver arrived at the pickup — ${gpsEvidence(6.80131, -58.15532)} 12m away, fix 4s old`,
      'Arrived at stop 1 — no GPS fix on file',
      null,
    ];
    const t0 = Date.now() - 60_000;
    for (const [i, note] of notes.entries()) {
      await sys(() => app.prisma.orderStatusLog.create({
        data: { orderId: ride.id, status: i === 0 ? 'PENDING' : 'RIDE_IN_PROGRESS', changedBy: passenger.userId, note, createdAt: new Date(t0 + i * 1_000) },
      }));
    }

    const res = await app.inject({ method: 'GET', url: `/api/v1/rides/${ride.id}`, headers: { authorization: `Bearer ${passenger.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('gps:');
    expect(res.body).not.toContain('6.80131');
    expect(res.body).not.toContain('no GPS fix');
    const rows = res.json().data.statusHistory as Array<Record<string, unknown>>;
    expect(rows.map((r) => r['note'])).toEqual(['Ride requested — fixed fare $1500', 'Driver arrived at the pickup', 'Arrived at stop 1', null]);
    expect(Object.keys(rows[1]!).sort()).toEqual(['changedBy', 'createdAt', 'id', 'note', 'orderId', 'status']);
    expect(rows.map((r) => r['status'])).toEqual(['PENDING', 'RIDE_IN_PROGRESS', 'RIDE_IN_PROGRESS', 'RIDE_IN_PROGRESS']);
  });
});
