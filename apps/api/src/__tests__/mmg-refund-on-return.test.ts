// [BUG-HUNT-2 G22 · COORD 4 Nov 2026] A paid MMG order that came back owes its customer, on the rail. Through the real routes on a
// real database: the store's "goods are back", and support's finding on a dispute that held it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { MMG_RETURN_NO_FIGURE_SUBJECT, MMG_RETURN_REFUND_REASON } from '../modules/order/mmg-refund-rail';
import { resolveMmgClaimDisagreement } from '../modules/order/mmg-claim.service';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

const DAY = 86_400_000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:mmg-refund-on-return');
type Actor = { id: string; token: string };

let app: FastifyInstance;
let customer: Actor; let owner: Actor; let riderUser: Actor; let admin: Actor;
let vendorId = ''; let riderId = ''; let storeName = '';
const people: string[] = [];
const orderIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole, adminRow = false): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Mo', lastName: 'Back', roles, activeRole: active, status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...(adminRow ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'back', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: user.id, token };
}

const paidByStore = () => ({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgAttestedRef: `PAY${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`, mmgAttestedAt: new Date(), mmgAttestedAmount: 1500, mmgClaimRevision: 1 });

/** An order on its way back to the store, its case waiting for the store's "goods are back". */
async function returning(over: Record<string, unknown>) {
  const row = await sys(async () => {
    const created = await app.prisma.order.create({ data: {
      orderNumber: `BCK-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: customer.id, vendorId, status: 'PENDING', paymentMethod: 'CASH', paymentStatus: 'PENDING',
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, ...over,
    } as never });
    await walkOrderStatus(app.prisma, created.id, 'RETURNING', { riderId, acceptedAt: new Date(), pickedUpAt: new Date() });
    await app.prisma.custodyRecoveryCase.deleteMany({ where: { orderId: created.id } });
    await app.prisma.custodyRecoveryCase.create({ data: { orderId: created.id, reason: 'RECIPIENT_ABSENT', state: 'RETURN_REQUIRED', holderRiderId: riderId, deadlineAt: new Date(Date.now() + DAY) } as never });
    return app.prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  });
  orderIds.push(row.id);
  return row;
}

function call(method: 'GET' | 'POST', url: string, as: Actor, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${as.token}`, ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as never } : {}) });
}
const goodsBack = (id: string) => call('POST', `/api/v1/vendor/orders/${id}/recovery/return-received`, owner, {});
const owedOn = (id: string) => sys(() => app.prisma.mmgRefundObligation.findMany({ where: { orderId: id } }));
const row = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const told = (userId: string, orderId: string, kind: string) => sys(() => app.prisma.notification.findMany({ where: { userId, data: { path: ['kind'], equals: kind }, AND: [{ data: { path: ['orderId'], equals: orderId } }] } }));
const resolve = (id: string, resolution: string, revision: number) => call('POST', `/api/v1/admin/orders/${id}/payment-claim/resolve`, admin, { resolution, note: 'Checked the store statement', expectedClaimRevision: revision }, { 'x-swift-reason': 'Support checked both sides and decided this payment.' });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  vi.stubEnv('LIFECYCLE_V2', '1');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  customer = await actor(['CUSTOMER'], 'CUSTOMER');
  owner = await actor(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  riderUser = await actor(['MOVER', 'CUSTOMER'], 'MOVER');
  admin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
  storeName = `Back Shop ${wordFreeTag(4)}`;
  await sys(async () => {
    const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    vendorId = (await app.prisma.vendor.create({ data: {
      ownerId: vendorOwner.id, name: storeName, slug: `back-${nanoid(10).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '1 Back Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1, status: 'ACTIVE', isVerified: true,
    } })).id;
    riderId = (await app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } as never })).id;
  });
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.mmgRefundObligation.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.mmgRefundSend.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.custodyRecoveryCase.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.supportTicket.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.rider.deleteMany({ where: { id: riderId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await purgeAuditLogs(app.prisma, { userId: { in: people } }, 'test-cleanup:mmg-refund-on-return');
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  });
  await app.close();
  vi.unstubAllEnvs();
});

describe('[G22] a paid MMG order came back, no dispute', () => {
  it('the store confirms the goods: one OWED record in that commit, money untouched, both told once, and the rail takes it from there', async () => {
    const o = await returning(paidByStore());
    const res = await goodsBack(o.id);
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(o.id);
    expect(after).toMatchObject({ status: 'RETURNED', paymentStatus: 'CLAIMED' });
    expect(String(after.totalAmount)).toBe('1500');
    const owed = await owedOn(o.id);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ kind: 'CANCELLATION', status: 'OWED', basis: 'ATTESTED_REMAINDER', reason: MMG_RETURN_REFUND_REASON, vendorId, customerId: customer.id, createdById: owner.id });
    expect(Number(owed[0]!.amount)).toBe(1500);

    const toCustomer = await told(customer.id, o.id, 'mmg_refund_owed');
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0]!.body).toContain(`${storeName} received GY$1,500 by MMG and must refund it to you by`);
    expect(toCustomer[0]!.data).toMatchObject({ audience: 'customer' });
    const toStore = await told(owner.id, o.id, 'mmg_refund_owed_store');
    expect(toStore).toHaveLength(1);
    expect(toStore[0]!.body).toContain('send them GY$1,500 from your MMG by');
    expect(toStore[0]!.data).toMatchObject({ audience: 'business' });

    const seen = (await call('GET', `/api/v1/customer/orders/${o.id}`, customer)).json().data;
    expect(seen.mmgRefund.line).toContain(`${storeName} owes you GY$1,500 by MMG`);
    const desk = (await call('GET', `/api/v1/vendor/orders/${o.id}`, owner)).json().data;
    expect(desk.mmgRefund).toMatchObject({ canMarkSent: true });
    const sent = await call('POST', `/api/v1/vendor/orders/${o.id}/mmg-refunds/send`, owner, { reference: `REF${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`, amount: 1500 });
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await owedOn(o.id))[0]!.status).toBe('SENT');
  });

  it('a second tap changes nothing and tells nobody twice', async () => {
    const o = await returning(paidByStore());
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    expect((await goodsBack(o.id)).statusCode).toBe(409);
    expect(await owedOn(o.id)).toHaveLength(1);
    expect(await told(customer.id, o.id, 'mmg_refund_owed')).toHaveLength(1);
  });

  it('what is already owed on the order comes off', async () => {
    const o = await returning(paidByStore());
    await sys(() => app.prisma.mmgRefundObligation.create({ data: {
      orderId: o.id, vendorId, customerId: customer.id, kind: 'LINE_REMOVED', orderItemId: nanoid(10), causeKey: `line:${nanoid(10)}:close`, status: 'OWED', amount: 400, basis: 'ALG-25', deadlineHours: 72, dueAt: new Date(Date.now() + DAY), createdById: owner.id,
    } as never }));
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    const owed = (await owedOn(o.id)).find((r) => r.kind === 'CANCELLATION')!;
    expect(Number(owed.amount)).toBe(1100);
  });

  it('with everything already owed there is nothing to add, and the return still closes', async () => {
    const o = await returning(paidByStore());
    await sys(() => app.prisma.mmgRefundObligation.create({ data: {
      orderId: o.id, vendorId, customerId: customer.id, kind: 'LINE_REMOVED', orderItemId: nanoid(10), causeKey: `line:${nanoid(10)}:close`, status: 'OWED', amount: 1500, basis: 'ALG-25', deadlineHours: 72, dueAt: new Date(Date.now() + DAY), createdById: owner.id,
    } as never }));
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    expect((await row(o.id)).status).toBe('RETURNED');
    expect(await owedOn(o.id)).toHaveLength(1);
  });

  it('a payment MMG itself confirmed, with the store\'s attestation, is owed the same', async () => {
    const o = await returning({ ...paidByStore(), paymentStatus: 'CAPTURED' });
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    expect(await owedOn(o.id)).toHaveLength(1);
  });

  it.each([
    ['a cash order', {}],
    ['an MMG order nobody paid', { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' }],
    ['a payment support ruled never came, with the store\'s old word still on the row', { ...paidByStore(), paymentStatus: 'PENDING' }],
    ['a cash order, whatever the row says', { ...paidByStore(), paymentMethod: 'CASH', paymentStatus: 'CAPTURED' }],
  ])('%s owes nothing here', async (_label, over) => {
    const o = await returning(over);
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    expect(await owedOn(o.id)).toEqual([]);
    expect(await told(customer.id, o.id, 'mmg_refund_owed')).toEqual([]);
  });
});

describe('[G22 · COORD 4 Nov 2026] a paid MMG order came back and no figure is known', () => {
  const noFigure = { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' };
  const cases = (id: string) => sys(() => app.prisma.supportTicket.findMany({ where: { orderId: id } }));

  it('opens a case for a person, says no figure is known, and invents no amount', async () => {
    const o = await returning(noFigure);
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    expect(await owedOn(o.id)).toEqual([]);
    expect(await told(customer.id, o.id, 'mmg_refund_owed')).toEqual([]);
    const [kase, ...more] = await cases(o.id);
    expect(more).toEqual([]);
    expect(kase).toMatchObject({ category: 'PAYMENT', subject: MMG_RETURN_NO_FIGURE_SUBJECT, userId: customer.id, status: 'OPEN' });
    expect(kase!.message).toContain('no amount is on record');
    expect(kase!.message).toContain('No refund has been recorded.');
    expect(kase!.message).not.toMatch(/GY\$|1,?500/);
    const page = await sys(() => app.prisma.notification.findMany({ where: { userId: admin.id, title: 'Paid MMG order came back, no amount known', data: { path: ['orderId'], equals: o.id } } }));
    expect(page).toHaveLength(1);
    expect(page[0]!.data).toMatchObject({ kind: 'support_ticket', ticketId: kase!.id });
  });

  it('a finding that the customer paid does the same, and the store is not sent to a button that is not there', async () => {
    const o = await returning({ ...paidByStore(), mmgAttestedAmount: null, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: new Date(), mmgClaimMismatchAt: new Date(), mmgClaimRevision: 2 });
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    expect(await cases(o.id)).toEqual([]);
    const held = await row(o.id);
    expect((await resolve(o.id, 'CUSTOMER_PAID', held.mmgClaimRevision)).statusCode).toBe(200);
    expect(await owedOn(o.id)).toEqual([]);
    expect(await cases(o.id)).toHaveLength(1);
    const store = await sys(() => app.prisma.notification.findMany({ where: { userId: owner.id, title: 'Payment review finished', data: { path: ['orderId'], equals: o.id } } }));
    expect(store[0]!.body).toContain('you owe the customer that money back.');
    expect(store[0]!.body).not.toContain('Refund sent');
    const page = await sys(() => app.prisma.notification.findMany({ where: { userId: admin.id, title: 'Paid MMG order came back, no amount known', data: { path: ['orderId'], equals: o.id } } }));
    expect(page).toHaveLength(1);
  });

  it('with a figure there is no case: the record is the follow-up', async () => {
    const o = await returning(paidByStore());
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    expect(await cases(o.id)).toEqual([]);
  });
});

describe('[G22] a paid MMG order came back with a dispute open', () => {
  const disputed = async () => {
    const o = await returning({ ...paidByStore(), customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: new Date(), mmgClaimMismatchAt: new Date(), mmgClaimRevision: 2 });
    expect((await goodsBack(o.id)).statusCode).toBe(200);
    return row(o.id);
  };

  it('the return records nothing while support has not decided', async () => {
    const o = await disputed();
    expect(await owedOn(o.id)).toEqual([]);
    expect(await told(customer.id, o.id, 'mmg_refund_owed')).toEqual([]);
  });

  it('support finds it paid: owed, in the finding\'s commit, once however often the finding is replayed', async () => {
    const o = await disputed();
    const res = await resolve(o.id, 'CUSTOMER_PAID', o.mmgClaimRevision);
    expect(res.statusCode, res.body).toBe(200);
    const owed = await owedOn(o.id);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ kind: 'CANCELLATION', status: 'OWED', createdById: admin.id });
    expect(Number(owed[0]!.amount)).toBe(1500);
    expect((await row(o.id)).paymentStatus).toBe('CLAIMED');
    expect((await resolve(o.id, 'CUSTOMER_PAID', o.mmgClaimRevision)).statusCode).toBeLessThan(500);
    expect(await owedOn(o.id)).toHaveLength(1);
  });

  it('the finding and what it opens are one commit: a record that fails takes the finding back', async () => {
    const o = await disputed();
    await expect(sys(() => app.prisma.$transaction((tx) => resolveMmgClaimDisagreement(tx, {
      orderId: o.id, tenantId: o.tenantId, resolution: 'CUSTOMER_PAID', expectedClaimRevision: o.mmgClaimRevision, note: 'Checked the store statement', actorId: admin.id,
      audit: async () => undefined,
      afterDecision: async () => { throw new Error('the record was refused'); },
    })))).rejects.toThrow('the record was refused');
    expect(await row(o.id)).toMatchObject({ mmgClaimResolution: null, mmgClaimRevision: o.mmgClaimRevision });
    expect((await row(o.id)).mmgClaimMismatchAt).toBeInstanceOf(Date);
  });

  it('a finding on an order still out with the rider records nothing: it can still be delivered', async () => {
    const o = await returning({ ...paidByStore(), customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: new Date(), mmgClaimMismatchAt: new Date(), mmgClaimRevision: 2 });
    const res = await resolve(o.id, 'CUSTOMER_PAID', o.mmgClaimRevision);
    expect(res.statusCode, res.body).toBe(200);
    expect((await row(o.id)).status).toBe('RETURNING');
    expect(await owedOn(o.id)).toEqual([]);
  });

  it('support finds it was not paid: nothing is owed', async () => {
    const o = await disputed();
    expect((await resolve(o.id, 'CUSTOMER_DID_NOT_PAY', o.mmgClaimRevision)).statusCode).toBe(200);
    expect(await owedOn(o.id)).toEqual([]);
  });
});
