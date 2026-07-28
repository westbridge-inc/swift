import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// GET /vendor/bookings — the Services schedule. Vendor-scoped, date-windowed,
// CANCELLED hidden, joined to the service + customer. Failure/edge paths: another
// vendor's booking never leaks; out-of-window is excluded; from/to narrows.

const HOUR = 3600_000;
let app: FastifyInstance;
const userIds: string[] = [];
const createdVendorIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let itemId = '';
let otherItemId = '';
let customerId = '';

async function makeVendor(name: string): Promise<{ vendorId: string; itemId: string; token: string }> {
  const u = await app.prisma.user.create({
    data: { phone: `+59200909${String(Math.floor(Math.random() * 900) + 100)}`, firstName: name, lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'b', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: u.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name, slug: `sched-${nanoid(6)}`, vendorType: 'SERVICE', phone: '+5920090900', addressLine1: '5 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Services', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: `${name} Haircut`, basePrice: 3000, isAvailable: true } });
  return { vendorId: vendor.id, itemId: item.id, token };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const mine = await makeVendor('Salon');
  vendorId = mine.vendorId; itemId = mine.itemId; vendorToken = mine.token;
  const other = await makeVendor('Rival');
  otherItemId = other.itemId;

  const cust = await app.prisma.user.create({
    data: { phone: `+59200909${String(Math.floor(Math.random() * 900) + 100)}`, firstName: 'Nia', lastName: 'Client', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cust.id);
  customerId = cust.id;

  const now = Date.now();
  await app.prisma.booking.createMany({
    data: [
      { itemId, customerId, slotStart: new Date(now + 24 * HOUR), slotEnd: new Date(now + 25 * HOUR), status: 'RESERVED' },       // in window
      { itemId, customerId, slotStart: new Date(now + 30 * 24 * HOUR), slotEnd: new Date(now + 30 * 24 * HOUR + HOUR), status: 'RESERVED' }, // past the 14-day window
      { itemId, customerId, slotStart: new Date(now + 26 * HOUR), slotEnd: new Date(now + 27 * HOUR), status: 'CANCELLED' },       // in window but cancelled
      { itemId: otherItemId, customerId, slotStart: new Date(now + 24 * HOUR), slotEnd: new Date(now + 25 * HOUR), status: 'RESERVED' }, // another vendor's
    ],
  });
});

afterAll(async () => {
  await app.prisma.booking.deleteMany({ where: { itemId: { in: [itemId, otherItemId] } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const get = (qs = '') =>
  app.inject({ method: 'GET', url: `/api/v1/vendor/bookings${qs}`, headers: { authorization: `Bearer ${vendorToken}`, 'x-vendor-id': vendorId } });

describe('GET /vendor/bookings — the Services schedule', () => {
  it('returns only this store’s upcoming, non-cancelled appointments, with service + customer', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as any[];
    // Exactly the one in-window RESERVED booking of OUR store — the out-of-window,
    // the cancelled, and the other vendor's are all excluded.
    expect(rows).toHaveLength(1);
    const b = rows[0];
    expect(b.serviceName).toBe('Salon Haircut');
    expect(b.status).toBe('RESERVED');
    expect(b.customer.firstName).toBe('Nia');
    expect(typeof b.slotStart).toBe('string');
    expect(b.price).toBe(3000);
  });

  it('a narrow from/to window excludes appointments outside it', async () => {
    // A 2-hour window starting well after the single in-range slot (which is ~24h out).
    const from = new Date(Date.now() + 5 * 24 * HOUR).toISOString();
    const to = new Date(Date.now() + 5 * 24 * HOUR + 2 * HOUR).toISOString();
    const res = await get(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data as any[]).toHaveLength(0);
  });
});
