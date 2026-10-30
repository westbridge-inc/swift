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
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] One owner, many branches: an "All branches"
// order board and a per-branch sales summary.
//  - GET /vendor/orders?scope=all lists every store the caller works in, even
//    while the phone or website has one store selected (they always send it);
//    each order names its store. A team member sees only the stores they were
//    added to — never another branch of the same owner.
//  - GET /vendor/stores/summary: today / 7 days / 30 days per branch and in all,
//    for the stores where the caller may see sales (owner everywhere, a manager
//    where they manage); staff-only callers are refused.
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const orderIds: string[] = [];

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Board', lastName: `Person${userIds.length}`, roles, activeRole, isPhoneVerified: true,
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'chains-board', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function store(ownerId: string, name: string) {
  const v = await app.prisma.vendor.create({ data: {
    ownerId, name, slug: `chain-board-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Board Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  vendorIds.push(v.id);
  return v;
}

async function order(vendorId: string, customerId: string, status: 'PENDING' | 'DELIVERED', total: number) {
  const o = await app.prisma.order.create({ data: {
    orderNumber: `CHB-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status, fulfillment: 'PICKUP',
    deliveryAddress: 'counter', deliveryLat: 6.81, deliveryLng: -58.16, pickupAddress: 'counter', pickupLat: 6.81, pickupLng: -58.16,
    subtotalBase: total, subtotalMarkup: 0, subtotalCustomer: total, deliveryFee: 0, totalAmount: total, paymentMethod: 'CASH',
  } });
  orderIds.push(o.id);
  return o;
}

const get = (token: string, url: string, vendorId?: string) => app.inject({
  method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...(vendorId ? { 'x-vendor-id': vendorId } : {}) },
});

let owner: { userId: string; token: string };
let north: { id: string; name: string };
let camp: { id: string; name: string };
let northOrder: { id: string };
let campOrder: { id: string };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  ownerIds.push(vo.id);
  north = await store(vo.id, `Royal North ${wordFreeTag(5)}`);
  camp = await store(vo.id, `Royal Camp ${wordFreeTag(5)}`);
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  northOrder = await order(north.id, customer.userId, 'PENDING', 1500);
  campOrder = await order(camp.id, customer.userId, 'PENDING', 2500);
  await order(north.id, customer.userId, 'DELIVERED', 4000);
  await order(camp.id, customer.userId, 'DELIVERED', 6000);
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const idsOf = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.map((o) => o.id);

describe('[CHAINS] GET /vendor/orders?scope=all — the all-branches board', () => {
  it('lists every branch\'s orders even while one store is selected, each naming its store', async () => {
    const one = await get(owner.token, '/api/v1/vendor/orders?status=PENDING', north.id);
    expect(one.statusCode, one.body).toBe(200);
    expect(idsOf(one)).toEqual([northOrder.id]);
    const all = await get(owner.token, '/api/v1/vendor/orders?status=PENDING&scope=all', north.id);
    expect(all.statusCode, all.body).toBe(200);
    expect(new Set(idsOf(all))).toEqual(new Set([northOrder.id, campOrder.id]));
    const camps = all.json().data.find((o: { id: string }) => o.id === campOrder.id);
    expect(camps.vendor).toMatchObject({ id: camp.id, name: camp.name });
  });

  it('a team member sees only the stores they work in, never another branch of the owner', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    const all = await get(member.token, '/api/v1/vendor/orders?status=PENDING&scope=all', north.id);
    expect(all.statusCode, all.body).toBe(200);
    expect(idsOf(all)).toEqual([northOrder.id]);
  });
});

describe('[CHAINS] GET /vendor/stores/summary — sales per branch', () => {
  it('the owner sees each branch and the total', async () => {
    const res = await get(owner.token, '/api/v1/vendor/stores/summary', north.id);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    const byId = new Map(data.branches.map((b: { vendorId: string }) => [b.vendorId, b]));
    expect(byId.get(north.id)).toMatchObject({ name: north.name, today: { orders: 2, revenue: 4000 }, pendingOrders: 1 });
    expect(byId.get(camp.id)).toMatchObject({ name: camp.name, today: { orders: 2, revenue: 6000 }, pendingOrders: 1 });
    expect(data.total).toMatchObject({ today: { orders: 4, revenue: 10000 }, pendingOrders: 2 });
  });

  it('a manager of one branch (staff at another) sees only the branch they manage', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'MANAGER', invitedBy: owner.userId } });
    await app.prisma.vendorStaff.create({ data: { vendorId: camp.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    const res = await get(member.token, '/api/v1/vendor/stores/summary', camp.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.branches.map((b: { vendorId: string }) => b.vendorId)).toEqual([north.id]);
    expect(res.json().data.total.today.revenue).toBe(4000);
  });

  it('staff only: refused', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: camp.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    const res = await get(member.token, '/api/v1/vendor/stores/summary', camp.id);
    expect(res.statusCode).toBe(403);
  });
});
