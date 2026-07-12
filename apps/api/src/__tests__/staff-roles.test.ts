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

// ---------------------------------------------------------------------------
// Staff & roles (master plan §4.1). Failure paths first: STAFF is refused on
// menu/hours/billing; MANAGER is refused on staff/billing; removal cuts access
// immediately; store selection stays IDOR-safe for staff; the store's
// verification belongs to the OWNER so staff can work a verified store.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200298${String(seq).padStart(2, '0')}`,
      firstName: 'Team',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/team.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'team-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, phone: user.phone };
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, token?: string, vendorId?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(vendorId ? { 'x-vendor-id': vendorId } : {}),
    },
  });
}

let owner: { userId: string; token: string; phone: string };
let managerUser: { userId: string; token: string; phone: string };
let staffUser: { userId: string; token: string; phone: string };
let vendorId: string;
let categoryId: string;
let otherVendorId: string;

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  managerUser = await makeUser(['CUSTOMER'], 'CUSTOMER');
  staffUser = await makeUser(['CUSTOMER'], 'CUSTOMER');

  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id,
      name: `Team Bistro ${nanoid(4)}`,
      slug: `team-bistro-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: '+5920029900',
      addressLine1: '3 Crew Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } });
  categoryId = category.id;

  // A second, unrelated store — the IDOR probe target.
  const otherOwner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const otherVo = await app.prisma.vendorOwner.create({ data: { userId: otherOwner.userId } });
  const other = await app.prisma.vendor.create({
    data: {
      ownerId: otherVo.id,
      name: `Other Store ${nanoid(4)}`,
      slug: `other-store-${nanoid(6)}`,
      vendorType: 'STORE',
      phone: '+5920029901',
      addressLine1: '9 Elsewhere', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  otherVendorId = other.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Owner manages the team', () => {
  it('adding an unknown phone fails with a friendly 404', async () => {
    const res = await inject('POST', '/api/v1/vendor/staff', { phone: '+5920000000099', role: 'STAFF' }, owner.token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('USER_NOT_FOUND');
  });

  it('owner adds a manager and a staff member by phone', async () => {
    const m = await inject('POST', '/api/v1/vendor/staff', { phone: managerUser.phone, role: 'MANAGER' }, owner.token);
    expect(m.statusCode).toBe(200);
    expect(m.json().data.role).toBe('MANAGER');

    const s = await inject('POST', '/api/v1/vendor/staff', { phone: staffUser.phone, role: 'STAFF' }, owner.token);
    expect(s.statusCode).toBe(200);

    const dupe = await inject('POST', '/api/v1/vendor/staff', { phone: staffUser.phone, role: 'STAFF' }, owner.token);
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('ALREADY_STAFF');

    const list = await inject('GET', '/api/v1/vendor/staff', undefined, owner.token);
    expect(list.json().data).toHaveLength(2);
  });

  it('a member joining sees the store through /profile with their role', async () => {
    const res = await inject('GET', '/api/v1/vendor/profile', undefined, staffUser.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.myRole).toBe('STAFF');
    expect(res.json().data.vendors).toHaveLength(1);
    expect(res.json().data.vendors[0].id).toBe(vendorId);
    // Billing never reaches staff
    expect(res.json().data.vendors[0].subscription).toBeUndefined();
  });
});

describe('Role gates hold', () => {
  it('STAFF works the queue but cannot touch menu, hours, or billing', async () => {
    const orders = await inject('GET', '/api/v1/vendor/orders', undefined, staffUser.token);
    expect(orders.statusCode).toBe(200);

    const toggleOrders = await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, staffUser.token);
    expect(toggleOrders.statusCode).toBe(200);
    // put it back
    await inject('PUT', '/api/v1/vendor/vendor/toggle-orders', {}, staffUser.token);

    const createItem = await inject('POST', '/api/v1/vendor/items', { categoryId, name: 'Sneaky Special', basePrice: 1000 }, staffUser.token);
    expect(createItem.statusCode).toBe(403);
    expect(createItem.json().error.code).toBe('STAFF_FORBIDDEN');

    const hours = await inject('PUT', '/api/v1/vendor/hours', { hours: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00', isClosed: false }] }, staffUser.token);
    expect(hours.statusCode).toBe(403);

    const sub = await inject('GET', '/api/v1/vendor/subscription', undefined, staffUser.token);
    expect(sub.statusCode).toBe(403);

    const staffList = await inject('GET', '/api/v1/vendor/staff', undefined, staffUser.token);
    expect(staffList.statusCode).toBe(403);
  });

  it('MANAGER runs the store (menu works — owner verification carries) but not staff/billing', async () => {
    const createItem = await inject('POST', '/api/v1/vendor/items', { categoryId, name: 'Manager Special', basePrice: 2500 }, managerUser.token);
    expect(createItem.statusCode).toBe(200);

    const sub = await inject('GET', '/api/v1/vendor/subscription', undefined, managerUser.token);
    expect(sub.statusCode).toBe(403);

    const addStaff = await inject('POST', '/api/v1/vendor/staff', { phone: owner.phone, role: 'STAFF' }, managerUser.token);
    expect(addStaff.statusCode).toBe(403);
    expect(addStaff.json().error.code).toBe('STAFF_FORBIDDEN');
  });

  it('staff cannot jump to a store they are not a member of (IDOR probe)', async () => {
    // Requesting the other store falls back to the member store — never leaks.
    const res = await inject('GET', '/api/v1/vendor/profile', undefined, staffUser.token, otherVendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.vendors[0].id).toBe(vendorId);

    const items = await inject('GET', '/api/v1/vendor/items', undefined, staffUser.token, otherVendorId);
    expect(items.statusCode).toBe(200);
  });

  it('role change + removal apply immediately', async () => {
    const list = await inject('GET', '/api/v1/vendor/staff', undefined, owner.token);
    const staffRow = list.json().data.find((m: any) => m.userId === staffUser.userId);

    const promoted = await inject('PUT', `/api/v1/vendor/staff/${staffRow.id}`, { role: 'MANAGER' }, owner.token);
    expect(promoted.statusCode).toBe(200);
    const nowManager = await inject('POST', '/api/v1/vendor/items', { categoryId, name: 'Promoted Plate', basePrice: 1800 }, staffUser.token);
    expect(nowManager.statusCode).toBe(200);

    const removed = await inject('DELETE', `/api/v1/vendor/staff/${staffRow.id}`, undefined, owner.token);
    expect(removed.statusCode).toBe(200);

    const after = await inject('GET', '/api/v1/vendor/profile', undefined, staffUser.token);
    expect(after.statusCode).toBe(403); // outsider again — authz answers, not existence
  });
});
