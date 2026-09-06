/**
 * [DOC-1 §31.5 · §31.6 · DOC-INV-48 · P31-2] test_vendor_collects_uses_claim_semantics
 *
 * On the store's own wallet Swift has no proof: the store's "payment received" is a
 * CLAIM. It lands as CLAIMED (never CAPTURED), is recorded as an assertion in the audit
 * trail, lets the order proceed (the store took the risk), opens the door without cash,
 * and reads as "reported received by the store" on the receipt. The customer's own claim
 * is recorded beside it; a dispute after the store's claim is a mismatch that holds
 * dispatch until a person resolves it. A source ratchet keeps the route from ever
 * writing a capture again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { assertMmgFulfilmentAllowed, MMG_MONEY_MOVED } from '../modules/order/order.service';
import { handoverAuthorityFor } from '../modules/order/handover-authority';
import { isCapturedMmg } from '../modules/dispatch/rescue';
import { renderReceiptHtml } from '../modules/order/receipt';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-claim-semantics-test');

let app: FastifyInstance;
let customerId = '', customerToken = '', vendorOwnerId = '', vendorToken = '', vendorId = '', adminId = '', adminToken = '';
const users: string[] = [];

async function person(n: number, roles: string[], active: string, extra: Record<string, unknown> = {}) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59262${NUM}${n}`, firstName: 'Claim', lastName: `Sem${n}`, roles: roles as never, activeRole: active as never, countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, ...extra,
  } as never }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: active, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `cs-${n}-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
  return { id: u.id, token };
}
async function mmgOrder(status: string) {
  return system(() => app.prisma.order.create({ data: {
    orderNumber: `CS${NUM}${nanoid(4).toUpperCase()}`, customerId, vendorId, status: status as never, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, tipAmount: 0, totalAmount: 3500,
    deliveryAddress: '1 Test St', deliveryLat: 6.8, deliveryLng: -58.16,
  } }));
}
const confirm = (orderId: string, reference: string) => app.inject({ method: 'POST', url: `/api/v1/vendor/orders/${orderId}/confirm-payment`, payload: { reference }, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json', 'x-vendor-id': vendorId } });
const claim = (orderId: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/v1/customer/orders/${orderId}/payment-claim`, payload, headers: { authorization: `Bearer ${customerToken}`, 'content-type': 'application/json' } });
const orderOf = (id: string) => system(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const c = await person(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } }); customerId = c.id; customerToken = c.token;
  const v = await person(2, ['VENDOR_OWNER'], 'VENDOR_OWNER'); vendorOwnerId = v.id; vendorToken = v.token;
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: vendorOwnerId, vendors: { create: {
    name: `Claim Store ${RUN}`, slug: `claim-store-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59262${NUM}9`, addressLine1: '2 Test St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'ACTIVE', isVerified: true, acceptingOrders: true, mmgPayUrl: 'https://pay.example/store',
  } } }, include: { vendors: true } }));
  vendorId = owner.vendors[0]!.id;
  const a = await person(3, ['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } }); adminId = a.id; adminToken = a.token;
});

afterAll(async () => {
  await system(async () => {
    // order_status_logs is append-only — deleting the orders cascades it
    await app.prisma.order.deleteMany({ where: { customerId } });
    const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: owners.map((o) => o.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { data: { path: ['kind'], equals: 'mmg_claim_mismatch' } }] } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P31-2] claim, not fact', () => {
  it('the store\'s "payment received" lands as CLAIMED, never CAPTURED; it is an audited assertion; the order may proceed and the door opens without cash; the receipt says "reported"', async () => {
    const order = await mmgOrder('PENDING');
    const res = await confirm(order.id, `REF${RUN}A`);
    expect(res.statusCode).toBe(200);
    const after = await orderOf(order.id);
    expect(after.paymentStatus).toBe('CLAIMED');
    expect(after.mmgAttestedRef).toBe(`REF${RUN}A`.toUpperCase()); // the route normalises the wallet's reference
    const trail = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'VENDOR_CLAIMED_PAYMENT_RECEIVED', entityId: order.id } }));
    expect(trail).not.toBeNull();
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', orderType: 'FOOD' }, 'ACCEPTED')).not.toThrow();
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', orderType: 'FOOD' }, 'ACCEPTED')).toThrow(/can move only after/);
    expect(handoverAuthorityFor({ ...(after as unknown as Record<string, unknown>), paymentStatus: 'CLAIMED' } as never).permitted).toBe('DELIVER_NO_CASH');
    expect(isCapturedMmg({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' })).toBe(true);
    expect(MMG_MONEY_MOVED.has('CLAIMED') && MMG_MONEY_MOVED.has('CAPTURED') && !MMG_MONEY_MOVED.has('PENDING')).toBe(true);
    const html = renderReceiptHtml({ ...(after as unknown as Record<string, unknown>), items: [], paymentStatus: 'CLAIMED' } as never);
    expect(html).toContain('reported received by the store');
    expect(html).not.toContain('Paid by MMG');
  });

  it('the customer\'s own claim is recorded beside the store\'s; a dispute after the store claimed is a mismatch that holds dispatch until an admin resolves it', async () => {
    const order = await mmgOrder('PENDING');
    const mine = await claim(order.id, { paid: true, reference: `REF${RUN}B` });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).toMatchObject({ storeClaimed: false });
    expect((await orderOf(order.id)).customerPaymentRef).toBe(`REF${RUN}B`);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'CUSTOMER_CLAIMED_PAID', entityId: order.id } }))).toBe(1);
    expect((await confirm(order.id, `REF${RUN}B`)).statusCode).toBe(200);
    const dispute = await claim(order.id, { paid: false });
    expect(dispute.statusCode).toBe(200);
    expect(dispute.json().data.mismatch).toBe(true);
    const held = await orderOf(order.id);
    expect(held.mmgClaimMismatchAt).not.toBeNull();
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: held.paymentStatus, orderType: 'FOOD', mmgClaimMismatchAt: held.mmgClaimMismatchAt }, 'ACCEPTED')).toThrow(/disputes the store/);
    expect(await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'mmg_claim_mismatch' }, body: { contains: order.id } } }))).toBeGreaterThanOrEqual(1);
    const resolved = await app.inject({ method: 'POST', url: `/api/v1/admin/orders/${order.id}/payment-claim/resolve`, payload: { resolution: 'CUSTOMER_PAID', note: 'Wallet statement shows the transfer' }, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': `Resolved ${RUN}: statement checked` } });
    expect(resolved.statusCode).toBe(200);
    const cleared = await orderOf(order.id);
    expect(cleared.mmgClaimMismatchAt).toBeNull();
    expect(cleared.paymentStatus).toBe('CLAIMED');
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: cleared.paymentStatus, orderType: 'FOOD', mmgClaimMismatchAt: null }, 'ACCEPTED')).not.toThrow();
  });

  it('DOC-INV-48 ratchet: the attestation route never writes a capture, and no VENDOR_COLLECTS field is named as confirmed', () => {
    const route = readFileSync(join(__dirname, '..', 'modules', 'vendor', 'vendor.routes.ts'), 'utf8');
    const i = route.indexOf('recordVendorAttestation(tx');
    const block = route.slice(Math.max(0, i - 3000), i + 1500);
    expect(block).not.toMatch(/data:\s*\{\s*paymentStatus:\s*'CAPTURED'/);
    expect(block).toMatch(/data:\s*\{\s*paymentStatus:\s*'CLAIMED'/);
    const attestation = readFileSync(join(__dirname, '..', 'modules', 'vendor', 'mmg-attestation.ts'), 'utf8');
    expect(attestation).not.toMatch(/payment_confirmed|paymentConfirmed/);
  });
});
