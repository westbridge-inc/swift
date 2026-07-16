import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// Bookable time slots for a SERVICE appointment listing, generated from
// Item.bookingConfig. Slots must align to the duration, sit in a day-window,
// be in the future — and actually be accepted by checkout (so the generator and
// BookingService.validateSlot agree).
const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let token: string;
let userId: string;
let apptItemId: string;
let regularItemId: string;
let config: { durationMinutes: number; slots: Array<{ dayOfWeek: number; start: string; end: string }> };

function nextDateForDow(dow: number): string {
  const d = new Date();
  for (let i = 1; i <= 7; i++) {
    const c = new Date(d.getTime() + i * DAY);
    if (c.getUTCDay() === dow) return c.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const appt = await app.prisma.item.findFirst({ where: { fulfillment: 'APPOINTMENT' }, select: { id: true, bookingConfig: true } });
  apptItemId = appt!.id;
  config = appt!.bookingConfig as unknown as typeof config;
  const reg = await app.prisma.item.findFirst({ where: { fulfillment: 'DELIVERY' }, select: { id: true } });
  regularItemId = reg!.id;

  const user = await app.prisma.user.create({
    data: { phone: `+592002990${Math.floor(Math.random() * 90 + 10)}`, firstName: 'Slot', lastName: 'Tester', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  userId = user.id;
  token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'slots', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
});

afterAll(async () => {
  // Guarded: if beforeAll dies before userId is set, an undefined here would
  // strip the where-clause and DELETE EVERY ROW (the pressure-test wipe).
  if (userId) {
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  }
  await app.close();
});

describe('appointment slots', () => {
  it('returns aligned, future slots on a configured day', async () => {
    const dow = config.slots[0]!.dayOfWeek;
    const res = await get(`/api/v1/customer/items/${apptItemId}/slots?date=${nextDateForDow(dow)}`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.durationMinutes).toBe(config.durationMinutes);
    expect(data.slots.length).toBeGreaterThan(0);
    for (const s of data.slots as string[]) {
      expect(new Date(s).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('returns no slots on a day with no window', async () => {
    const configured = new Set(config.slots.map((s) => s.dayOfWeek));
    let offDay = 0;
    for (let i = 0; i < 7; i++) if (!configured.has(i)) { offDay = i; break; }
    const res = await get(`/api/v1/customer/items/${apptItemId}/slots?date=${nextDateForDow(offDay)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.slots.length).toBe(0);
  });

  it('rejects a non-appointment listing (400)', async () => {
    const res = await get(`/api/v1/customer/items/${regularItemId}/slots?date=${nextDateForDow(config.slots[0]!.dayOfWeek)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_BOOKABLE');
  });
});
