import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PaymentStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// Row 52 (payment half). Coordinator ruling 5 Oct: the store OWNER and a
// MANAGER may confirm that an MMG payment landed; STAFF may not. A refused tap
// leaves the order exactly as it was, and the confirmation audit row names
// WHO confirmed it (store member id + role) and the MMG reference.
// The role is the caller's role in the store that owns the order, never the
// role at whichever store is selected in the header.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];
const vendorOwnerIds: string[] = [];
let seq = 0;
const phoneBase = 592_616_000_000 + Math.floor(Math.random() * 300_000_000);

let owner: { id: string; token: string };
let ownerVendorOwnerId: string;
let vendorId: string;
let otherVendorId: string;
let customerId: string;

async function makeUser(roles: string[], activeRole: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Role',
      lastName: `U${seq}`,
      roles: roles as never,
      activeRole: activeRole as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `role-${nanoid(8)}`, deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 864e5) },
  });
  return { id: user.id, token };
}

async function makeVendor(ownerId: string, name: string) {
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId,
      name,
      slug: `role-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `+${phoneBase + 900 + vendorIds.length}`,
      addressLine1: '1 Wallet St',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.801,
      longitude: -58.156,
      status: 'ACTIVE',
      isVerified: true,
      acceptingOrders: true,
      isCurrentlyOpen: true,
    },
  });
  vendorIds.push(vendor.id);
  return vendor.id;
}

async function makeOrder(forVendorId: string, paymentStatus: PaymentStatus = 'PENDING') {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `ROLE-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId: forVendorId,
      status: 'PREPARING',
      fulfillment: 'DELIVERY',
      deliveryAddress: 'x',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: 2000,
      subtotalMarkup: 0,
      subtotalCustomer: 2000,
      deliveryFee: 300,
      totalAmount: 2300,
      paymentMethod: 'MOBILE_MONEY',
      paymentStatus,
      mmgRecipientNameSnapshot: 'Role Diner',
    },
  });
  orderIds.push(order.id);
  return order;
}

async function addMember(userId: string, atVendorId: string, role: 'STAFF' | 'MANAGER') {
  const row = await app.prisma.vendorStaff.create({
    data: { vendorId: atVendorId, userId, role, invitedBy: owner.id },
  });
  return row.id;
}

const freshRef = (prefix: string) => `${prefix}${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

function confirm(orderId: string, token: string, reference: string, selectedVendorId?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/vendor/orders/${orderId}/confirm-payment`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(selectedVendorId ? { 'x-vendor-id': selectedVendorId } : {}),
    },
    payload: { reference },
  });
}

/** Everything a confirmation could change, read back for a byte-level compare. */
async function orderFootprint(orderId: string) {
  const order = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const audits = await app.prisma.auditLog.count({ where: { entityId: orderId } });
  const logs = await app.prisma.orderStatusLog.count({ where: { orderId } });
  return { order: JSON.stringify(order), audits, logs };
}

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
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  ownerVendorOwnerId = vo.id;
  vendorOwnerIds.push(vo.id);
  vendorId = await makeVendor(vo.id, 'Role Diner');
  otherVendorId = await makeVendor(vo.id, 'Role Diner Two');
  customerId = (await makeUser(['CUSTOMER'], 'CUSTOMER')).id;
});

afterAll(async () => {
  await purgeAuditLogs(app.prisma, { entityId: { in: orderIds } }, 'test-cleanup:l05-confirm-payment-role');
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vendorOwnerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[row 52] who may confirm an MMG payment', () => {
  it('STAFF is refused with 403 and the order, its audit trail and its status log are unchanged', async () => {
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await addMember(staff.id, vendorId, 'STAFF');
    const order = await makeOrder(vendorId);
    const before = await orderFootprint(order.id);

    const res = await confirm(order.id, staff.token, freshRef('STF'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_FORBIDDEN');

    expect(await orderFootprint(order.id)).toEqual(before);
  });

  it('STAFF is refused even on an order already claimed (no idempotent success leaks past the gate)', async () => {
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await addMember(staff.id, vendorId, 'STAFF');
    const order = await makeOrder(vendorId);
    const reference = freshRef('CLM');
    expect((await confirm(order.id, owner.token, reference)).statusCode).toBe(200);
    const before = await orderFootprint(order.id);

    const res = await confirm(order.id, staff.token, reference);
    expect(res.statusCode).toBe(403);
    expect(await orderFootprint(order.id)).toEqual(before);
  });

  it('a MANAGER confirms; the audit row names the member id, the role and the MMG reference', async () => {
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const memberId = await addMember(manager.id, vendorId, 'MANAGER');
    const order = await makeOrder(vendorId);
    const reference = freshRef('MGR');

    const res = await confirm(order.id, manager.token, reference);
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe('CLAIMED');

    const audit = await app.prisma.auditLog.findFirstOrThrow({
      where: { entityId: order.id, action: 'VENDOR_CLAIMED_PAYMENT_RECEIVED' },
    });
    expect(audit.userId).toBe(manager.id);
    const changes = audit.changes as Record<string, unknown>;
    expect(changes['memberId']).toBe(memberId);
    expect(changes['memberRole']).toBe('MANAGER');
    expect(changes['reference']).toBe(reference);
  });

  it('the OWNER confirms; the audit row names the owner membership and role', async () => {
    const order = await makeOrder(vendorId);
    const reference = freshRef('OWN');

    const res = await confirm(order.id, owner.token, reference);
    expect(res.statusCode).toBe(200);

    const audit = await app.prisma.auditLog.findFirstOrThrow({
      where: { entityId: order.id, action: 'VENDOR_CLAIMED_PAYMENT_RECEIVED' },
    });
    const changes = audit.changes as Record<string, unknown>;
    expect(changes['memberId']).toBe(ownerVendorOwnerId);
    expect(changes['memberRole']).toBe('OWNER');
    expect(changes['reference']).toBe(reference);
  });

  it("a manager of another store who is only STAFF at this order's store is refused, whichever store is selected", async () => {
    const mixed = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await addMember(mixed.id, vendorId, 'STAFF');
    await addMember(mixed.id, otherVendorId, 'MANAGER');
    const order = await makeOrder(vendorId);
    const before = await orderFootprint(order.id);

    for (const selected of [undefined, otherVendorId, vendorId]) {
      const res = await confirm(order.id, mixed.token, freshRef('MIX'), selected);
      expect(res.statusCode, `selected=${selected ?? 'none'}`).toBe(403);
    }
    expect(await orderFootprint(order.id)).toEqual(before);

    // ...and the same person confirms an order of the store they manage.
    const managed = await makeOrder(otherVendorId);
    expect((await confirm(managed.id, mixed.token, freshRef('MIX'))).statusCode).toBe(200);
  });
});

describe('[row 52] the board and the order screen say who may confirm', () => {
  const boardFlag = async (token: string, orderId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor/orders?limit=100',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as Array<{ id: string; canConfirmPayment?: unknown }>).find((o) => o.id === orderId);
    expect(row, 'order on the board').toBeTruthy();
    return row!.canConfirmPayment;
  };
  const detailFlag = async (token: string, orderId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/vendor/orders/${orderId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data.canConfirmPayment;
  };

  it('owner and manager read true, staff read false, per the store that owns each order', async () => {
    const mixed = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await addMember(mixed.id, vendorId, 'STAFF');
    await addMember(mixed.id, otherVendorId, 'MANAGER');
    const staffSide = await makeOrder(vendorId);
    const managerSide = await makeOrder(otherVendorId);

    expect(await boardFlag(owner.token, staffSide.id)).toBe(true);
    expect(await detailFlag(owner.token, staffSide.id)).toBe(true);

    expect(await boardFlag(mixed.token, staffSide.id)).toBe(false);
    expect(await boardFlag(mixed.token, managerSide.id)).toBe(true);
    expect(await detailFlag(mixed.token, staffSide.id)).toBe(false);
    expect(await detailFlag(mixed.token, managerSide.id)).toBe(true);
  });
});
