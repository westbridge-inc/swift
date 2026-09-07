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
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', orderType: 'FOOD', mmgClaimMismatchAt: null }, 'ACCEPTED')).not.toThrow();
    // [DOC-INV-48 · 2026-09-07] The dispute gate was INERT at both assignment entrances.
    // `mmgClaimMismatchAt` was an OPTIONAL parameter property, so the dispatch-accept lock
    // (raw SQL, seven columns) and the board-grab payment gate both type-checked while
    // reading `undefined` — and a disputed order could be dispatched, prepared and handed
    // over. The field is required now, so a forgotten projection is a compile error; these
    // three assert the behaviour the compiler cannot see.
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', orderType: 'FOOD', mmgClaimMismatchAt: new Date() }, 'RIDER_ASSIGNED'))
      .toThrow(/disputes the store's payment claim/);
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', orderType: 'FOOD', mmgClaimMismatchAt: new Date() }, 'PREPARING'))
      .toThrow(/disputes the store's payment claim/);
    // HOSTILE: a caller that did not project the column must fail loudly, never pass.
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', orderType: 'FOOD' } as never, 'RIDER_ASSIGNED'))
      .toThrow(/was not projected/);
    expect(() => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', orderType: 'FOOD', mmgClaimMismatchAt: null }, 'ACCEPTED')).toThrow(/can move only after/);
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

// ---------------------------------------------------------------------------
// [DOC-INV-48 · F-103-04] THE DISAGREEMENT WAS DISCARDED IF THE CUSTOMER SPOKE
// FIRST.
//
// Codex's serial history, from source:
//
//   1. MOBILE_MONEY + PENDING + mmgClaimMismatchAt = null
//   2. the customer posts paid:false
//   3. the route records only an AuditLog — the order carries no negative fact
//   4. the store confirms payment, locks the order, sees PENDING, writes CLAIMED
//   5. final order is CLAIMED + mmgClaimMismatchAt = null
//   6. every repaired gate passes, and fulfilment proceeds although the two
//      claims disagree
//
// The cause was that ABSENCE meant two different things: "no claim has been
// made" and "the customer said they did not pay". It is now a fact of its own,
// written under the same row lock the store's confirm-payment takes.
//
// These are Codex's mandatory acceptance tests 1, 2 and 3.
// ---------------------------------------------------------------------------
describe('[F-103-04] a disagreement is recorded whichever side speaks first', () => {
  const gateFor = (o: { paymentStatus: string; mmgClaimMismatchAt: Date | null }) =>
    () => assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: o.paymentStatus, orderType: 'FOOD', mmgClaimMismatchAt: o.mmgClaimMismatchAt }, 'ACCEPTED');

  it('ACCEPTANCE 1 — store first, then the customer denies: mismatch, and the gate holds', async () => {
    const order = await mmgOrder('PENDING');
    expect((await confirm(order.id, `REF${RUN}S1`)).statusCode).toBe(200);
    expect((await claim(order.id, { paid: false })).json().data.mismatch).toBe(true);

    const held = await orderOf(order.id);
    expect(held.paymentStatus).toBe('CLAIMED');
    expect(held.mmgClaimMismatchAt).not.toBeNull();
    expect(held.customerClaimedNotPaidAt, 'the denial is durable in its own right').not.toBeNull();
    expect(gateFor(held)).toThrow(/disputes the store/);
  });

  it('ACCEPTANCE 2 — CUSTOMER FIRST, then the store claims: mismatch too. It must NOT end CLAIMED + null', async () => {
    const order = await mmgOrder('PENDING');

    // The customer denies BEFORE the store has said anything. On main this
    // wrote nothing to the order at all.
    const denial = await claim(order.id, { paid: false });
    expect(denial.statusCode).toBe(200);
    expect(denial.json().data.mismatch, 'no mismatch YET — the store has not claimed').toBe(false);
    const afterDenial = await orderOf(order.id);
    expect(afterDenial.customerClaimedNotPaidAt, 'but the denial is on the order, not only in an audit row').not.toBeNull();
    expect(afterDenial.mmgClaimMismatchAt).toBeNull();

    // Now the store claims receipt. This is step 4 of Codex's history.
    expect((await confirm(order.id, `REF${RUN}S2`)).statusCode).toBe(200);

    const held = await orderOf(order.id);
    expect(held.paymentStatus).toBe('CLAIMED');
    expect(held.mmgClaimMismatchAt, 'THE defect: CLAIMED + null passed every gate').not.toBeNull();
    expect(gateFor(held), 'and the gate holds it, exactly as in the other ordering').toThrow(/disputes the store/);
    // the trail says the claim ARRIVED disputed, rather than quietly becoming so
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'MMG_CLAIM_MISMATCH', entityId: order.id } }))).toBeGreaterThanOrEqual(1);
  });

  it('ACCEPTANCE 3 — the two claims raced: whichever commits first, one honest held state', async () => {
    for (let round = 0; round < 4; round += 1) {
      const order = await mmgOrder('PENDING');
      const [store, customer] = await Promise.all([
        confirm(order.id, `REF${RUN}R${round}`),
        claim(order.id, { paid: false }),
      ]);
      const fresh = await orderOf(order.id);
      const shot = JSON.stringify({ round, store: store.statusCode, customer: customer.statusCode, paymentStatus: fresh.paymentStatus, mismatch: fresh.mmgClaimMismatchAt, denied: fresh.customerClaimedNotPaidAt });

      expect(fresh.customerClaimedNotPaidAt, `${shot} — the denial is never lost`).not.toBeNull();
      // The one state that must not exist: the store's claim standing, the
      // customer's denial on record, and nothing holding the order.
      const claimedAndUnheld = fresh.paymentStatus === 'CLAIMED' && fresh.mmgClaimMismatchAt === null;
      expect(claimedAndUnheld, `${shot} — CLAIMED with a denial on record and no hold`).toBe(false);
      if (fresh.paymentStatus === 'CLAIMED') expect(gateFor(fresh), shot).toThrow(/disputes the store/);
    }
  });

  it('a customer who changes their answer supersedes their own denial', async () => {
    const order = await mmgOrder('PENDING');
    expect((await claim(order.id, { paid: false })).statusCode).toBe(200);
    expect((await orderOf(order.id)).customerClaimedNotPaidAt).not.toBeNull();

    expect((await claim(order.id, { paid: true, reference: `REF${RUN}C` })).statusCode).toBe(200);
    const after = await orderOf(order.id);
    expect(after.customerClaimedNotPaidAt, 'the old answer no longer stands').toBeNull();
    expect(after.customerClaimedPaidAt).not.toBeNull();

    // …and the store's later claim is therefore ordinary, not disputed.
    expect((await confirm(order.id, `REF${RUN}C`)).statusCode).toBe(200);
    const done = await orderOf(order.id);
    expect(done.paymentStatus).toBe('CLAIMED');
    expect(done.mmgClaimMismatchAt).toBeNull();
    expect(gateFor(done)).not.toThrow();
  });
});
