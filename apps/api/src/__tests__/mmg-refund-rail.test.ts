// [BUG-HUNT-2 G08] The OWED refund becomes real, through the real routes on a real database. A paid MMG order support closed
// owes a refund from the store's own MMG. The store says "Refund sent", the customer says it arrived or it did not, support
// finds out, and the record can be voided by two people. RECORD ONLY: Swift holds no money and moves none. Nothing here may
// write paymentStatus, the total or a cash-refund column, and no surface says "refunded" before someone said it arrived.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { openMmgRefundObligation } from '../modules/order/mmg-refund-law';
import { MMG_REFUND_DISPUTE_SUBJECT, resolveMmgRefundDispute } from '../modules/order/mmg-refund-rail';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

const DAY = 86_400_000;
const REASON = 'Support checked both sides and recorded the outcome of this refund.';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:mmg-refund-rail');
type Actor = { id: string; token: string };

let app: FastifyInstance;
let customer: Actor; let owner: Actor; let manager: Actor; let staff: Actor; let otherOwner: Actor; let admin: Actor; let boss: Actor;
let vendorId = '';
const people: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];
const clusterIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole, adminRow = false): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Rae', lastName: 'Fund', roles, activeRole: active, status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...(adminRow ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'refund', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: user.id, token };
}

async function store(of: Actor): Promise<string> {
  const row = await sys(() => app.prisma.vendorOwner.create({ data: { userId: of.id } }));
  const vendor = await sys(() => app.prisma.vendor.create({ data: {
    ownerId: row.id, name: `Refund Shop ${wordFreeTag(4)}`, slug: `refund-${nanoid(10).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Refund Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1, status: 'ACTIVE', isVerified: true,
  } }));
  vendorIds.push(vendor.id);
  return vendor.id;
}

/** A paid MMG order support closed: CANCELLED with its OWED obligation, the way mmg-store-close writes it. */
async function owed(amount = 1300, dueInMs = 3 * DAY, forVendor = vendorId) {
  const order = await sys(() => app.prisma.$transaction(async (tx) => {
    const created = await tx.order.create({ data: {
      orderNumber: `RAIL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId: customer.id, vendorId: forVendor, status: 'ACCEPTED',
      paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgAttestedRef: `PAY${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`, mmgAttestedAt: new Date(), mmgAttestedAmount: amount,
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: amount, subtotalMarkup: 0, subtotalCustomer: amount, deliveryFee: 0, totalAmount: amount,
    } });
    await tx.mmgRefundObligation.create({ data: { ...openMmgRefundObligation({
      kind: 'CANCELLATION', tenantId: created.tenantId, orderId: created.id, vendorId: forVendor, customerId: customer.id, amount: new Prisma.Decimal(amount), currencyCode: 'GYD', basis: 'ATTESTED_REMAINDER', reason: REASON, createdById: null,
    }, { deadlineHours: 72, missLimit: 2 }, new Date()), dueAt: new Date(Date.now() + dueInMs) } });
    return tx.order.update({ where: { id: created.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  }));
  orderIds.push(order.id);
  return order;
}

function call(method: 'GET' | 'POST', url: string, as: Actor, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${as.token}`, ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
const ref = () => `RFD${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`;
const sendRefund = (id: string, as: Actor = owner, body: Record<string, unknown> = { reference: ref(), amount: 1300 }) => call('POST', `/api/v1/vendor/orders/${id}/mmg-refunds/send`, as, body);
const storeRead = async (id: string, as: Actor = owner) => (await call('GET', `/api/v1/vendor/orders/${id}`, as)).json().data;
const customerRead = async (id: string) => (await call('GET', `/api/v1/customer/orders/${id}`, customer)).json().data;
const answer = (id: string, sendId: string, received: boolean, as: Actor = customer) => call('POST', `/api/v1/customer/orders/${id}/mmg-refunds/${sendId}/answer`, as, { received });
const obligationOf = (id: string) => sys(() => app.prisma.mmgRefundObligation.findFirstOrThrow({ where: { orderId: id } }));
const sendOf = (id: string) => sys(() => app.prisma.mmgRefundSend.findFirstOrThrow({ where: { orderId: id } }));
const noticesFor = (userId: string, orderId: string) => sys(() => app.prisma.notification.findMany({ where: { userId, data: { path: ['orderId'], equals: orderId } } }));
async function sent(amount = 1300) {
  const order = await owed(amount);
  const res = await sendRefund(order.id, owner, { reference: ref(), amount });
  expect(res.statusCode, res.body).toBe(200);
  return { order, sendId: res.json().data.sendId as string };
}
async function disputed() {
  const { order, sendId } = await sent();
  expect((await answer(order.id, sendId, false)).statusCode).toBe(200);
  return { order, sendId };
}
async function moneyUntouched(id: string, before: { paymentStatus: string; totalAmount: Prisma.Decimal }) {
  const after = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
  expect(after).toMatchObject({ paymentStatus: before.paymentStatus, status: 'CANCELLED', refundOwedAt: null, refundSettledAt: null, refundRef: null });
  expect(String(after.totalAmount)).toBe(String(before.totalAmount));
}
const resolve = (sendId: string, received: boolean, as: Actor = admin) => call('POST', `/api/v1/admin/mmg-refunds/sends/${sendId}/resolve`, as, { received, note: 'Checked the store MMG statement' }, { 'x-swift-reason': REASON });
const voidIt = (id: string, as: Actor = admin, approval?: string) => call('POST', `/api/v1/admin/mmg-refunds/${id}/void`, as, { note: 'Settled in cash between them' }, { 'x-swift-reason': REASON, ...(approval ? { [APPROVAL_HEADER]: approval } : {}) });
async function approvedVoid(id: string) {
  const ask = await voidIt(id);
  expect(ask.statusCode, ask.body).toBe(202);
  const approval = ask.json().error.details.approvalId as string;
  const yes = await call('POST', `/api/v1/admin/approvals/${approval}/decide`, boss, { approve: true }, { 'x-swift-reason': REASON });
  expect(yes.statusCode, yes.body).toBe(200);
  return voidIt(id, admin, approval);
}

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
  otherOwner = await actor(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  manager = await actor(['CUSTOMER'], 'CUSTOMER');
  staff = await actor(['CUSTOMER'], 'CUSTOMER');
  admin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
  boss = await actor(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', true);
  vendorId = await store(owner);
  await store(otherOwner);
  await sys(() => app.prisma.vendorStaff.createMany({ data: [{ vendorId, userId: manager.id, role: 'MANAGER', invitedBy: owner.id }, { vendorId, userId: staff.id, role: 'STAFF', invitedBy: owner.id }] }));
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.identityClusterMember.deleteMany({ where: { clusterId: { in: clusterIds } } });
    await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusterIds } } });
    await app.prisma.mmgRefundObligation.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.mmgRefundSend.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.supportTicket.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: people } } });
    await purgeAuditLogs(app.prisma, { userId: { in: people } }, 'test-cleanup:mmg-refund-rail');
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  });
  await app.close();
  vi.unstubAllEnvs();
});

describe('[G08] what each side sees while it is owed', () => {
  it('the store sees what it owes and by when, with the door', async () => {
    const order = await owed();
    const view = (await storeRead(order.id)).mmgRefund;
    expect(view).toMatchObject({ state: 'OWED', amount: '1300.00', canMarkSent: true });
    expect(view.line).toContain('GY$1,300');
    expect(view.line).toContain('Refund sent');
  });

  it('staff below a manager see it and have no door', async () => {
    const order = await owed();
    expect((await storeRead(order.id, staff)).mmgRefund.canMarkSent).toBe(false);
    expect((await storeRead(order.id, manager)).mmgRefund.canMarkSent).toBe(true);
    const refused = await sendRefund(order.id, staff);
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await obligationOf(order.id)).status).toBe('OWED');
  });

  it('the customer is told who owes what, and is not told it is refunded', async () => {
    const order = await owed();
    const view = (await customerRead(order.id)).mmgRefund;
    expect(view).toMatchObject({ state: 'OWED', amount: '1300.00', canAnswer: false, sendId: null });
    expect(view.line).toContain('owes you GY$1,300');
    expect(view.line).toContain('contact Swift support');
    expect(view.line.toLowerCase()).not.toContain('refunded');
  });

  it('a past-due refund says so on both sides', async () => {
    const order = await owed(1300, -60_000);
    expect((await storeRead(order.id)).mmgRefund).toMatchObject({ state: 'OVERDUE', canMarkSent: true });
    expect((await customerRead(order.id)).mmgRefund.state).toBe('OVERDUE');
  });

  it('an order with no refund says nothing', async () => {
    const cash = await sys(() => app.prisma.order.create({ data: {
      orderNumber: `RAIL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId: customer.id, vendorId, status: 'ACCEPTED', paymentMethod: 'CASH',
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 100, subtotalMarkup: 0, subtotalCustomer: 100, deliveryFee: 0, totalAmount: 100,
    } }));
    orderIds.push(cash.id);
    expect((await storeRead(cash.id)).mmgRefund).toBeNull();
    expect((await customerRead(cash.id)).mmgRefund).toBeNull();
  });
});

describe('[G08] nobody is sent to the wrong person', () => {
  async function paidOpen() {
    const order = await sys(() => app.prisma.order.create({ data: {
      orderNumber: `RAIL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId: customer.id, vendorId, status: 'ACCEPTED', acceptedAt: new Date(),
      paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimRevision: 3, mmgAttestedRef: `PAY${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`, mmgAttestedAt: new Date(), mmgAttestedAmount: 1300,
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1300, subtotalMarkup: 0, subtotalCustomer: 1300, deliveryFee: 0, totalAmount: 1300,
    } }));
    orderIds.push(order.id);
    return order;
  }

  it('the store\'s Reject on a paid order says who closes it, not "the store refunds you"', async () => {
    const order = await paidOpen();
    const res = await call('PUT' as 'POST', `/api/v1/vendor/orders/${order.id}/reject`, owner, { reason: 'Out of stock' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('MMG_CANCEL_UNAVAILABLE');
    expect(res.json().error.message).toContain('Contact Swift support');
    expect(res.json().error.message).not.toContain('refunds you directly');
  });

  it('support\'s Cancel on a paid order names support\'s own door', async () => {
    const order = await paidOpen();
    const res = await call('PUT' as 'POST', `/api/v1/admin/orders/${order.id}/cancel`, admin, { refund: false }, { 'x-swift-reason': REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toContain('Close: store refunds');
  });

  it('the customer is told to contact the store, and Swift support if it does not answer', async () => {
    const order = await paidOpen();
    const view = await customerRead(order.id);
    expect(view.canCancel).toBe(false);
    expect(view.cancelUnavailable.message).toContain('contact Swift support');
  });

  it('no admin closes a paid order they are on', async () => {
    const asCustomer = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const order = await paidOpen();
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { customerId: asCustomer.id } }));
    const ask = await call('POST', `/api/v1/admin/orders/${order.id}/close-store-refund`, asCustomer, { expectedClaimRevision: 3 }, { 'x-swift-reason': REASON });
    expect(ask.statusCode, ask.body).toBe(202);
    const approval = ask.json().error.details.approvalId as string;
    expect((await call('POST', `/api/v1/admin/approvals/${approval}/decide`, boss, { approve: true }, { 'x-swift-reason': REASON })).statusCode).toBe(200);
    const res = await call('POST', `/api/v1/admin/orders/${order.id}/close-store-refund`, asCustomer, { expectedClaimRevision: 3 }, { 'x-swift-reason': REASON, [APPROVAL_HEADER]: approval });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OWN_ORDER');
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))).status).toBe('ACCEPTED');
  });
});

describe('[G08] the store says "Refund sent"', () => {
  it('records the reference and moves the obligation; no money anywhere; the customer is asked', async () => {
    const order = await owed();
    const reference = ref();
    const res = await sendRefund(order.id, owner, { reference: reference.toLowerCase(), amount: 1300 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'SENT', replayed: false });
    expect(await obligationOf(order.id)).toMatchObject({ status: 'SENT', revision: 1 });
    const send = await sendOf(order.id);
    expect(send).toMatchObject({ mmgRefundRef: reference.toUpperCase(), sentById: owner.id, answer: null, feeBorneBySwift: null });
    expect(String(send.amount)).toBe('1300');
    await moneyUntouched(order.id, order);
    const told = await noticesFor(customer.id, order.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Did your refund arrive?' });
    expect(told[0]!.data).toMatchObject({ kind: 'mmg_refund_sent', audience: 'customer' });
    expect((await storeRead(order.id)).mmgRefund).toMatchObject({ state: 'SENT', canMarkSent: false });
    const view = (await customerRead(order.id)).mmgRefund;
    expect(view).toMatchObject({ state: 'SENT', canAnswer: true, sendId: send.id });
    expect(view.line).toContain(reference.toUpperCase());
  });

  it('a manager may; the amount must be exactly what is owed; nothing is written on a refusal', async () => {
    const order = await owed();
    const short = await sendRefund(order.id, manager, { reference: ref(), amount: 1299 });
    expect(short.statusCode).toBe(409);
    expect(short.json().error.code).toBe('MMG_REFUND_AMOUNT_MISMATCH');
    expect(short.json().error.message).toContain('GY$1,300');
    expect(await sys(() => app.prisma.mmgRefundSend.count({ where: { orderId: order.id } }))).toBe(0);
    expect((await sendRefund(order.id, manager, { reference: ref(), amount: '1300' })).statusCode).toBe(200);
  });

  it('a reference is evidence only if it is unique, and the payment\'s own reference is not a refund', async () => {
    const first = await owed();
    const reference = ref();
    expect((await sendRefund(first.id, owner, { reference, amount: 1300 })).statusCode).toBe(200);
    const second = await owed();
    const reused = await sendRefund(second.id, owner, { reference, amount: 1300 });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('MMG_REFUND_REF_USED');
    const own = await sendRefund(second.id, owner, { reference: second.mmgAttestedRef, amount: 1300 });
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe('MMG_REFUND_REF_IS_PAYMENT');
    expect((await obligationOf(second.id)).status).toBe('OWED');
  });

  it('a second tap after a lost reply is the same answer: one send, one notice', async () => {
    const order = await owed();
    const reference = ref();
    expect((await sendRefund(order.id, owner, { reference, amount: 1300 })).statusCode).toBe(200);
    const again = await sendRefund(order.id, owner, { reference, amount: 1300 });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.replayed).toBe(true);
    expect(await sys(() => app.prisma.mmgRefundSend.count({ where: { orderId: order.id } }))).toBe(1);
    expect(await noticesFor(customer.id, order.id)).toHaveLength(1);
  });

  it('nothing owed, nothing sent; another store\'s order is not found', async () => {
    const { order } = await sent();
    const twice = await sendRefund(order.id, owner, { reference: ref(), amount: 1300 });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('MMG_REFUND_NOTHING_OWED');
    const mine = await owed();
    expect((await sendRefund(mine.id, otherOwner)).statusCode).toBe(404);
  });
});

describe('[G08] the customer says whether it arrived', () => {
  it('"It arrived": confirmed, the store told, the screens say so, no money moved', async () => {
    const { order, sendId } = await sent();
    const res = await answer(order.id, sendId, true);
    expect(res.statusCode, res.body).toBe(200);
    expect(await obligationOf(order.id)).toMatchObject({ status: 'CONFIRMED', resolvedById: customer.id });
    expect(await sendOf(order.id)).toMatchObject({ answer: 'RECEIVED', supportTicketId: null });
    expect((await noticesFor(owner.id, order.id)).map((n) => n.title)).toContain('Refund confirmed');
    expect((await customerRead(order.id)).mmgRefund).toMatchObject({ state: 'DONE', canAnswer: false });
    expect((await storeRead(order.id)).mmgRefund.state).toBe('DONE');
    await moneyUntouched(order.id, order);
  });

  it('"It did not arrive": disputed, one support case in the same commit, the store told', async () => {
    const { order, sendId } = await sent();
    expect((await answer(order.id, sendId, false)).statusCode).toBe(200);
    expect((await obligationOf(order.id)).status).toBe('DISPUTED');
    const tickets = await sys(() => app.prisma.supportTicket.findMany({ where: { orderId: order.id } }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ userId: customer.id, category: 'PAYMENT', subject: MMG_REFUND_DISPUTE_SUBJECT });
    expect((await sendOf(order.id)).supportTicketId).toBe(tickets[0]!.id);
    expect((await noticesFor(owner.id, order.id)).map((n) => n.title)).toContain('Customer says the refund did not arrive');
    expect((await customerRead(order.id)).mmgRefund.state).toBe('DISPUTED');
  });

  it('only the customer of that order; a repeat is the same answer; a change of mind goes to support', async () => {
    const { order, sendId } = await sent();
    expect((await answer(order.id, sendId, true, otherOwner)).statusCode).toBe(404);
    expect((await obligationOf(order.id)).status).toBe('SENT');
    expect((await answer(order.id, sendId, true)).statusCode).toBe(200);
    const again = await answer(order.id, sendId, true);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.replayed).toBe(true);
    const flip = await answer(order.id, sendId, false);
    expect(flip.statusCode).toBe(409);
    expect(flip.json().error.code).toBe('MMG_REFUND_ALREADY_ANSWERED');
    expect((await obligationOf(order.id)).status).toBe('CONFIRMED');
  });
});

describe('[G08] the send is judged under the lock', () => {
  const voidRow = async (orderId: string) => {
    const row = await obligationOf(orderId);
    await sys(() => app.prisma.mmgRefundObligation.update({ where: { id: row.id }, data: { status: 'VOIDED', sendId: null, revision: { increment: 1 } } }));
  };

  it('a customer cannot answer a send nothing is covered by any more: no answer, no case', async () => {
    const { order, sendId } = await sent();
    await voidRow(order.id);
    const res = await answer(order.id, sendId, false);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('MMG_REFUND_NOT_OPEN');
    expect(await sendOf(order.id)).toMatchObject({ answer: null, supportTicketId: null });
    expect(await sys(() => app.prisma.supportTicket.count({ where: { orderId: order.id } }))).toBe(0);
  });

  it('a finding cannot be made twice: the first stands, whichever way the second goes', async () => {
    const { order, sendId } = await disputed();
    expect((await resolve(sendId, false)).statusCode).toBe(200);
    const second = await resolve(sendId, true);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('MMG_REFUND_NOT_OPEN');
    expect(await sendOf(order.id)).toMatchObject({ resolution: 'NOT_RECEIVED' });
    expect((await obligationOf(order.id)).status).toBe('OWED');
  });

  it('a finding cannot be made twice the other way either: a refund found received stays found', async () => {
    const { order, sendId } = await disputed();
    expect((await resolve(sendId, true)).statusCode).toBe(200);
    const settled = await obligationOf(order.id);
    const second = await resolve(sendId, false);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('MMG_REFUND_NOT_OPEN');
    expect(await sendOf(order.id)).toMatchObject({ resolution: 'RECEIVED' });
    expect((await obligationOf(order.id)).status).toBe(settled.status);
  });

  it('a finding on a send nothing is covered by is refused, and nothing is written', async () => {
    const { order, sendId } = await disputed();
    await voidRow(order.id);
    const res = await resolve(sendId, true);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('MMG_REFUND_NOT_OPEN');
    expect(await sendOf(order.id)).toMatchObject({ resolution: null, resolvedById: null });
  });

  it('a send that changed under the decision loses: compare-and-set on its revision, and the whole commit goes back', async () => {
    const { order, sendId } = await disputed();
    await expect(resolveMmgRefundDispute(app.prisma, {
      sendId, actorId: admin.id, received: true, note: 'Checked',
      authorize: async (tx) => { await tx.mmgRefundSend.update({ where: { id: sendId }, data: { revision: { increment: 1 } } }); },
      audit: async () => undefined,
    })).rejects.toMatchObject({ code: 'MMG_REFUND_STALE' });
    expect((await obligationOf(order.id)).status).toBe('DISPUTED');
    expect(await sendOf(order.id)).toMatchObject({ resolution: null });
  });
});

describe('[G08] who may decide, by what the database says', () => {
  /** A cluster holding these accounts; `review` flags it for a person. */
  async function linked(accounts: string[], review = false) {
    return sys(async () => {
      const cluster = await app.prisma.identityCluster.create({ data: { authorityReviewRequired: review } });
      clusterIds.push(cluster.id);
      await app.prisma.identityClusterMember.createMany({ data: accounts.map((accountId) => ({ accountId, clusterId: cluster.id, linkedVia: [] })) });
      return cluster.id;
    });
  }
  async function asCustomer<T>(who: Actor, work: () => Promise<T>): Promise<T> {
    const saved = customer;
    customer = who;
    try { return await work(); } finally { customer = saved; }
  }

  it('an identity waiting for a person refuses the decision: it cannot be known who is on this order', async () => {
    const buyer = await actor(['CUSTOMER'], 'CUSTOMER');
    await linked([buyer.id], true);
    const { order, sendId } = await asCustomer(buyer, () => disputed());
    const res = await resolve(sendId, true);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
    expect((await obligationOf(order.id)).status).toBe('DISPUTED');
  });

  it('so does an admin whose own identity is waiting for a person', async () => {
    const reviewed = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    await linked([reviewed.id], true);
    const { sendId } = await disputed();
    const res = await resolve(sendId, true, reviewed);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
  });

  it('a linked account counts as the person: an admin linked to the customer is on the order', async () => {
    const buyer = await actor(['CUSTOMER'], 'CUSTOMER');
    const twin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    await linked([buyer.id, twin.id]);
    const { sendId } = await asCustomer(buyer, () => disputed());
    const res = await resolve(sendId, true, twin);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OWN_ORDER');
  });

  it('a staff account linked to a party makes it a staff order: a plain admin is refused, a SUPER_ADMIN not on it decides', async () => {
    const buyer = await actor(['CUSTOMER'], 'CUSTOMER');
    const hidden = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    await linked([buyer.id, hidden.id]);
    const { sendId } = await asCustomer(buyer, () => disputed());
    const res = await resolve(sendId, true);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ON_ORDER');
    expect((await resolve(sendId, true, boss)).statusCode).toBe(200);
  });

  /** An ask by `admin`, approved by `approver`. */
  async function approvedBy(approver: Actor, ask: () => ReturnType<typeof call>) {
    const asked = await ask();
    expect(asked.statusCode, asked.body).toBe(202);
    const approval = asked.json().error.details.approvalId as string;
    const yes = await call('POST', `/api/v1/admin/approvals/${approval}/decide`, approver, { approve: true }, { 'x-swift-reason': REASON });
    expect(yes.statusCode, yes.body).toBe(200);
    return approval;
  }

  it('the second person of a void may not be on the order either', async () => {
    const approver = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const order = await asCustomer(approver, () => owed());
    const row = await obligationOf(order.id);
    const approval = await approvedBy(approver, () => voidIt(row.id));
    const res = await voidIt(row.id, admin, approval);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('APPROVER_ON_ORDER');
    expect((await obligationOf(order.id)).status).toBe('OWED');
  });

  it('and a second person whose identity is waiting for a person refuses too', async () => {
    const order = await owed();
    const row = await obligationOf(order.id);
    const approver = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const approval = await approvedBy(approver, () => voidIt(row.id));
    await linked([approver.id], true);
    const res = await voidIt(row.id, admin, approval);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
    expect((await obligationOf(order.id)).status).toBe('OWED');
  });

  it('on a staff order the second person must be a SUPER_ADMIN too', async () => {
    const staffer = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const order = await asCustomer(staffer, () => owed());
    const row = await obligationOf(order.id);
    const plain = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const ask = () => voidIt(row.id, boss);
    const approval = await approvedBy(plain, ask);
    const res = await voidIt(row.id, boss, approval);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ON_ORDER');
    expect((await obligationOf(order.id)).status).toBe('OWED');
  });

  it('nor of a close', async () => {
    const approver = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const order = await sys(() => app.prisma.order.create({ data: {
      orderNumber: `RAIL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId: approver.id, vendorId, status: 'ACCEPTED', acceptedAt: new Date(),
      paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgClaimRevision: 3, mmgAttestedRef: `PAY${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`, mmgAttestedAt: new Date(), mmgAttestedAmount: 1300,
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1300, subtotalMarkup: 0, subtotalCustomer: 1300, deliveryFee: 0, totalAmount: 1300,
    } }));
    orderIds.push(order.id);
    const close = (headers: Record<string, string> = {}) => call('POST', `/api/v1/admin/orders/${order.id}/close-store-refund`, admin, { expectedClaimRevision: 3 }, { 'x-swift-reason': REASON, ...headers });
    const approval = await approvedBy(approver, () => close());
    const res = await close({ [APPROVAL_HEADER]: approval });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('APPROVER_ON_ORDER');
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id } }))).status).toBe('ACCEPTED');
  });
});

describe('[G08] support', () => {
  it('lists what is open: who owes what, how late, with no phone number', async () => {
    const overdue = await owed(1300, -60_000);
    const { order: argued } = await disputed();
    const res = await call('GET', '/api/v1/admin/mmg-refunds?filter=overdue&limit=100', admin);
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json().data.find((entry: { orderId: string }) => entry.orderId === overdue.id);
    expect(row).toMatchObject({ orderNumber: overdue.orderNumber, status: 'OWED', overdue: true, amount: '1300.00' });
    expect(row.storeName).toContain('Refund Shop');
    expect(res.body).not.toMatch(/\+592/);
    expect(res.json().data.some((entry: { orderId: string }) => entry.orderId === argued.id)).toBe(false);
    const all = await call('GET', '/api/v1/admin/mmg-refunds?limit=100', admin);
    const ids = all.json().data.map((entry: { orderId: string }) => entry.orderId);
    expect(ids).toEqual(expect.arrayContaining([overdue.id, argued.id]));
  });

  it('finds it arrived: closed, both sides told, the reason kept, no money moved', async () => {
    const { order, sendId } = await disputed();
    const res = await resolve(sendId, true);
    expect(res.statusCode, res.body).toBe(200);
    expect(await obligationOf(order.id)).toMatchObject({ status: 'SETTLED', resolvedById: admin.id });
    expect(await sendOf(order.id)).toMatchObject({ resolution: 'RECEIVED', resolvedById: admin.id });
    expect((await noticesFor(customer.id, order.id)).map((n) => n.title)).toContain('Refund closed');
    expect((await noticesFor(owner.id, order.id)).map((n) => n.title)).toContain('Refund closed');
    await moneyUntouched(order.id, order);
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: sendId } }))).toBeGreaterThan(0);
  });

  it('finds it did not arrive: owed again on a new deadline, that reference spent', async () => {
    const { order, sendId } = await disputed();
    const before = await obligationOf(order.id);
    const spent = (await sendOf(order.id)).mmgRefundRef;
    expect((await resolve(sendId, false)).statusCode).toBe(200);
    const row = await obligationOf(order.id);
    expect(row).toMatchObject({ status: 'OWED', sendId: null });
    expect(row.dueAt.getTime()).toBeGreaterThan(before.dueAt.getTime() - 60_000);
    expect(row.missedAt).toBeInstanceOf(Date);
    const again = await sendRefund(order.id, owner, { reference: spent, amount: 1300 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('MMG_REFUND_REF_USED');
    expect((await obligationOf(order.id)).status).toBe('OWED');
    expect((await sendRefund(order.id, owner, { reference: ref(), amount: 1300 })).statusCode).toBe(200);
    expect(await sys(() => app.prisma.mmgRefundSend.count({ where: { orderId: order.id } }))).toBe(2);
  });

  it('is refused on anything not in dispute', async () => {
    const { sendId } = await sent();
    const res = await resolve(sendId, true);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MMG_REFUND_TRANSITION_REFUSED');
  });

  it('voids only with a second person, the record kept, both sides told', async () => {
    const order = await owed();
    const row = await obligationOf(order.id);
    const res = await approvedVoid(row.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await obligationOf(order.id)).toMatchObject({ status: 'VOIDED', resolvedById: admin.id, sendId: null });
    expect((await noticesFor(customer.id, order.id)).map((n) => n.title)).toContain('Refund record closed');
    expect((await noticesFor(owner.id, order.id)).map((n) => n.title)).toContain('Refund record closed');
    await moneyUntouched(order.id, order);
  });

  it('no admin decides a refund they are a party to: not the customer, not the store', async () => {
    const asCustomer = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const saved = customer;
    customer = asCustomer;
    const mine = await disputed().catch((e) => { customer = saved; throw e; });
    customer = saved;
    const res = await resolve(mine.sendId, true, asCustomer);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OWN_ORDER');
    expect((await obligationOf(mine.order.id)).status).toBe('DISPUTED');

    const asOwner = await actor(['ADMIN', 'VENDOR_OWNER', 'CUSTOMER'], 'ADMIN', true);
    const shop = await store(asOwner);
    const theirs = await owed(1300, 3 * DAY, shop);
    const row = await obligationOf(theirs.id);
    const ask = await voidIt(row.id, asOwner);
    expect(ask.statusCode).toBe(202);
    const approval = ask.json().error.details.approvalId as string;
    expect((await call('POST', `/api/v1/admin/approvals/${approval}/decide`, boss, { approve: true }, { 'x-swift-reason': REASON })).statusCode).toBe(200);
    const refused = await voidIt(row.id, asOwner, approval);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('OWN_ORDER');
    expect((await obligationOf(theirs.id)).status).toBe('OWED');
  });

  it('a refund with a staff account on it goes to a SUPER_ADMIN who is not on it', async () => {
    const colleague = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const saved = customer;
    customer = colleague;
    const theirs = await disputed().catch((e) => { customer = saved; throw e; });
    customer = saved;
    const res = await resolve(theirs.sendId, true, admin);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ON_ORDER');
    expect((await resolve(theirs.sendId, true, boss)).statusCode).toBe(200);
  });
});
