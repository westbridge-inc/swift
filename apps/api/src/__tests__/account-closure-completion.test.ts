import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { AccountService, ACCOUNT_CLOSURE_SUBJECT } from '../modules/user/account.service';
import { SupportService } from '../modules/support/support.service';
import { NotificationService } from '../modules/notification/notification.service';
import { VerificationService } from '../modules/verification/verification.service';
import { runWithoutTenant, runWithTenant } from '../plugins/tenant-context';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// ---------------------------------------------------------------------------
// [DELETION-INTEGRITY] A business or advertiser closure request is completed.
//
// The app lets a business owner ask for closure in-app; the request becomes a
// support ticket. Nothing executed it: no route, worker or tool ever ran the
// closure for a live account, so a request could only ever be acknowledged.
// The support queue now completes it through the same erasure the person's own
// deletion uses — every obligation check still applies, so a request with live
// orders or open cash stays open and says what is outstanding.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
let adminId: string;
const userIds: string[] = [];
const vendorIds: string[] = [];
const orderIds: string[] = [];
const ticketIds: string[] = [];
const otherTenants: string[] = [];
let seq = 0;
const phoneBase = 592_018_000_000 + Math.floor(Math.random() * 900_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Closure', lastName: `Req${seq}`,
    email: `closure${seq}-${nanoid(6)}@example.com`, roles, activeRole: roles[0]!, isPhoneVerified: true,
  } });
  userIds.push(user.id);
  await app.prisma.session.create({ data: {
    userId: user.id, token: nanoid(32), refreshToken: nanoid(48), deviceId: 'c', deviceType: 'test',
    expiresAt: new Date(Date.now() + 86_400_000),
  } });
  return user;
}

async function makeBusiness() {
  const user = await makeUser(['VENDOR_OWNER', 'CUSTOMER']);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: 'Synthetic closure store', slug: `close-${nanoid(12)}`, vendorType: 'RESTAURANT',
    phone: 'synthetic', addressLine1: 'Synthetic', city: 'Synthetic', region: 'Synthetic', latitude: 0, longitude: 0,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true,
  } });
  vendorIds.push(vendor.id);
  const receipt = await new AccountService(app).requestClosure(user.id);
  ticketIds.push(receipt.ticketId);
  return { userId: user.id, vendorId: vendor.id, ticketId: receipt.ticketId };
}

const complete = (ticketId: string, reason: string | null = TEST_ADMIN_REASON) => app.inject({
  method: 'POST',
  url: `/api/v1/admin/support/${ticketId}/complete-account-closure`,
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  payload: reason ? { reason } : {},
});

beforeAll(async () => {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.ready();
  app = server;
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;
  adminId = login.json().data.user.id;
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, ...ticketIds.map((id) => ({ data: { path: ['ticketId'], equals: id } }))] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.supportTicket.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await runWithoutTenant(() => app.prisma.tenant.deleteMany({ where: { id: { in: otherTenants } } }));
  await app.close();
});

describe('[DELETION-INTEGRITY] support completes an in-app closure request', () => {
  it('closes the business account, de-identifies the person and resolves the request', async () => {
    const b = await makeBusiness();
    const res = await complete(b.ticketId);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().data).toMatchObject({ ticketId: b.ticketId, outcome: { deleted: true } });

    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: b.userId } });
    expect(user).toMatchObject({ status: 'DEACTIVATED', phone: `deleted:${b.userId}`, firstName: 'Deleted', email: null });
    expect(await app.prisma.session.count({ where: { userId: b.userId } })).toBe(0);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: b.vendorId } })).toMatchObject({ status: 'SUSPENDED', acceptingOrders: false });
    const ticket = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: b.ticketId } });
    expect(ticket).toMatchObject({ status: 'RESOLVED', resolution: 'ACTION_TAKEN', resolvedById: adminId });
    expect(ticket.resolvedAt).not.toBeNull();
  });

  it('keeps the request open, and the account untouched, while an order is still live', async () => {
    const b = await makeBusiness();
    const customer = await app.prisma.user.findFirstOrThrow({ where: { customer: { isNot: null } }, select: { id: true } });
    const order = await app.prisma.order.create({ data: {
      orderNumber: `CC-${nanoid(10).toUpperCase()}`, customerId: customer.id, vendorId: b.vendorId,
      orderType: 'FOOD_DELIVERY', status: 'PREPARING', deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    } });
    orderIds.push(order.id);
    const res = await complete(b.ticketId);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('ACTIVE_ORDERS');
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).toMatchObject({ status: 'ACTIVE', firstName: 'Closure' });
    expect(await app.prisma.session.count({ where: { userId: b.userId } })).toBe(1);
    expect(await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: b.ticketId } })).toMatchObject({ status: 'OPEN', resolvedAt: null });

    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    const retried = await complete(b.ticketId);
    expect(retried.statusCode, retried.payload).toBe(200);
    expect(await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: b.ticketId } })).toMatchObject({ status: 'RESOLVED' });
  });

  it('refuses a ticket that is not an in-app closure request', async () => {
    const user = await makeUser(['VENDOR_OWNER']);
    const ticket = await app.prisma.supportTicket.create({ data: {
      userId: user.id, category: 'ACCOUNT', subject: 'Please close my account', message: 'Typed by hand, never confirmed in the app.',
    } });
    ticketIds.push(ticket.id);
    const res = await complete(ticket.id);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('NOT_A_CLOSURE_REQUEST');
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ status: 'ACTIVE', firstName: 'Closure' });
  });

  it('refuses a hand-typed ticket that copies the closure request wording', async () => {
    // Any signed-in person can open a support ticket with any subject and
    // message. Only the confirmed in-app request (the step-up gated route)
    // leaves the server-side record that makes a ticket completable here.
    const user = await makeUser(['VENDOR_OWNER']);
    const ticket = await new SupportService(app.prisma, new NotificationService(app.prisma, app.io)).createTicket(user.id, {
      category: 'ACCOUNT', subject: ACCOUNT_CLOSURE_SUBJECT,
      message: 'Please close my Swift account and de-identify my personal data after resolving outstanding business obligations. This request was confirmed in the app.',
    });
    ticketIds.push(ticket.id);
    const res = await complete(ticket.id);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error.code).toBe('NOT_A_CLOSURE_REQUEST');
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ status: 'ACTIVE', firstName: 'Closure' });
    expect(await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'OPEN', resolvedAt: null });

    // The person then confirms closure in the app: the open ticket is reused
    // and becomes completable.
    const receipt = await new AccountService(app).requestClosure(user.id);
    expect(receipt.ticketId).toBe(ticket.id);
    const confirmed = await complete(ticket.id);
    expect(confirmed.statusCode, confirmed.payload).toBe(200);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ status: 'DEACTIVATED', phone: `deleted:${user.id}` });
  });

  it('refuses to close a staff account from the support queue', async () => {
    const staff = await makeUser(['ADMIN']);
    const receipt = await new AccountService(app).requestClosure(staff.id);
    ticketIds.push(receipt.ticketId);
    const res = await complete(receipt.ticketId);
    expect(res.statusCode, res.payload).toBe(403);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).toMatchObject({ status: 'ACTIVE', firstName: 'Closure' });
    expect(await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: receipt.ticketId } })).toMatchObject({ status: 'OPEN' });
  });

  it('requires a stated reason and refuses a request already resolved', async () => {
    const b = await makeBusiness();
    const unexplained = await complete(b.ticketId, null);
    expect(unexplained.statusCode, unexplained.payload).toBe(400);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).toMatchObject({ status: 'ACTIVE' });
    expect((await complete(b.ticketId)).statusCode).toBe(200);
    const again = await complete(b.ticketId);
    expect(again.statusCode, again.payload).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_RESOLVED');
  });

  it('a closed account\u2019s store cannot be reopened by the admin approve button', async () => {
    const b = await makeBusiness();
    expect((await complete(b.ticketId)).statusCode).toBe(200);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: b.vendorId } })).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'WIND_DOWN' });
    // Even if the owner's documents still read as verified (kept under a legal
    // hold, say), approving must not bring the closed account's store back.
    const verified = vi.spyOn(VerificationService.prototype, 'isRoleVerified').mockResolvedValue(true);
    try {
      const res = await app.inject({
        method: 'PUT', url: `/api/v1/admin/vendors/${b.vendorId}/approve`,
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, payload: { reason: TEST_ADMIN_REASON },
      });
      expect(res.statusCode, res.payload).toBe(409);
      expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    } finally { verified.mockRestore(); }
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: b.vendorId } })).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'WIND_DOWN', acceptingOrders: false });
  });

  it('if the store is wound down between the approve check and its write, approve still says the account is closed', async () => {
    const b = await makeBusiness();
    expect((await complete(b.ticketId)).statusCode).toBe(200);
    // The approve route's first read sees the store as it was a moment before
    // the closure landed; the activation write then meets the wound-down row.
    const real = app.prisma.vendor.findUnique.bind(app.prisma.vendor);
    let served = false;
    const stale = vi.spyOn(app.prisma.vendor, 'findUnique').mockImplementation((async (args: any) => {
      const row = await real(args);
      // Only the route's own read (the one that brings the owner), only once.
      if (!served && args?.include?.owner && row) { served = true; return { ...row, suspensionSource: null }; }
      return row;
    }) as never);
    const verified = vi.spyOn(VerificationService.prototype, 'isRoleVerified').mockResolvedValue(true);
    try {
      const res = await app.inject({
        method: 'PUT', url: `/api/v1/admin/vendors/${b.vendorId}/approve`,
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, payload: { reason: TEST_ADMIN_REASON },
      });
      expect(served, 'the approve route read the stale row').toBe(true);
      expect(res.statusCode, res.payload).toBe(409);
      expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    } finally { stale.mockRestore(); verified.mockRestore(); }
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: b.vendorId } })).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'WIND_DOWN' });
  });

  it('an admin cannot complete a closure request from another operator', async () => {
    // Pins the tenant wall: the ticket and the person are read through the
    // admin's own tenant, so the erasure can never run for someone outside it.
    const tenantId = `closure-tenant-b-${nanoid(6)}`;
    await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: tenantId, name: 'Closure tenant B', slug: tenantId, isActive: true } }));
    otherTenants.push(tenantId);
    seq += 1;
    const user = await runWithoutTenant(() => app.prisma.user.create({ data: {
      phone: `+${phoneBase + seq}`, firstName: 'Closure', lastName: `Req${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, tenantId,
    } }));
    userIds.push(user.id);
    const receipt = await runWithTenant(tenantId, () => new AccountService(app).requestClosure(user.id));
    ticketIds.push(receipt.ticketId);
    const res = await complete(receipt.ticketId);
    expect(res.statusCode, res.payload).toBe(404);
    expect(await runWithoutTenant(() => app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }))).toMatchObject({ status: 'ACTIVE', firstName: 'Closure' });
    expect(await runWithoutTenant(() => app.prisma.supportTicket.findUniqueOrThrow({ where: { id: receipt.ticketId } }))).toMatchObject({ status: 'OPEN', resolvedAt: null });
  });
});
