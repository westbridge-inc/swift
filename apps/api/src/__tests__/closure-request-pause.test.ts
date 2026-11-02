import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { ACCESS_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { ACCOUNT_CLOSURE_MESSAGE, ACCOUNT_CLOSURE_MESSAGE_WEBSITE, ACCOUNT_CLOSURE_SUBJECT } from '../modules/user/account-closure';
import { ACCOUNT_CLOSURE_CANCELLED, CLOSURE_ORDERS_PAUSED, CLOSURE_ORDERS_PAUSE_LIFTED, CLOSURE_PAUSE_REFUSAL, CLOSURE_PAUSE_REFUSAL_TEAM } from '../modules/user/closure-pause';
import { BILLING_HELD_FOR_CLOSURE, BILLING_RESUMED_AFTER_CLOSURE, CLOSURE_FEE_HOLD_NOTE } from '../modules/billing/closure-fee-hold';
import { BillingService } from '../modules/billing/billing.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { restoreBillingAccess } from '../modules/billing/billing-access';
import { SupportService } from '../modules/support/support.service';
import { NotificationService } from '../modules/notification/notification.service';
import { requestOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner ruling 1 Nov 2026] When a store owner asks Swift to close their account (on the website or
// in the app: one server path), the stores' NEW orders pause AT ONCE. Orders already placed still finish; Swift's
// team then completes the closure. Nothing reopens the store while the request is open (not the owner's "Resume
// orders", not a billing reinstatement, not the database itself); only Swift staff resolving the request, or the
// owner cancelling it, lifts the pause, each audited. The request's ticket says where it was sent from.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const ORIGIN = 'http://localhost:3001';
const BROWSER = { 'x-swift-client': 'web', origin: ORIGIN } as const;
const userIds: string[] = [];
const vendorIds: string[] = [];
const orderIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const DAY = 86_400_000;
const phoneBase = 592_018_600_000 + Math.floor(Math.random() * 90_000);

async function owner(stores: Array<Record<string, unknown>> = [{}]) {
  seq += 1;
  const phone = `+${phoneBase + seq}`;
  const user = await app.prisma.user.create({ data: {
    phone, firstName: 'Store', lastName: `Owner${seq}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, customer: { create: {} },
  } });
  userIds.push(user.id);
  const o = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const ids: string[] = [];
  for (const over of stores) {
    const v = await app.prisma.vendor.create({ data: {
      ownerId: o.id, name: `Synthetic pause store ${seq}-${ids.length}`, slug: `cp-${nanoid(12).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: 'synthetic', addressLine1: 'Synthetic', city: 'Synthetic', region: 'Synthetic', latitude: 0, longitude: 0,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: false, ...over,
    } });
    vendorIds.push(v.id);
    ids.push(v.id);
  }
  return { userId: user.id, phone, vendorIds: ids };
}

/** A code sign-in: as the website (cookies) or as the app (a bearer token). */
async function signIn(phone: string, as: 'website' | 'app'): Promise<Record<string, string>> {
  const code = await requestOtp(app, phone);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers: as === 'website' ? BROWSER : {}, payload: { phone, code } });
  expect(res.statusCode, res.payload).toBe(200);
  if (as === 'app') return { authorization: `Bearer ${res.json().data.tokens.accessToken as string}` };
  const cookie = ([] as string[]).concat((res.headers['set-cookie'] as string | string[]) ?? []).find((c) => c.startsWith(`${ACCESS_COOKIE}=`))!.split(';')[0]!;
  return { ...BROWSER, cookie };
}

const request = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/v1/customer/account/closure-request', headers });
const cancel = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/v1/customer/account/closure-request/cancel', headers });
const resume = (headers: Record<string, string>, vendorId: string) =>
  app.inject({ method: 'PUT', url: '/api/v1/vendor/vendor/toggle-orders', headers: { ...headers, 'x-vendor-id': vendorId }, payload: { acceptingOrders: true } });
const store = (id: string) => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { acceptingOrders: true, closurePausedAt: true, status: true } });
const audits = (ticketId: string, action: string) => app.prisma.auditLog.findMany({ where: { entity: 'SupportTicket', entityId: ticketId, action } });

beforeAll(async () => {
  process.env['CORS_ORIGIN'] = ORIGIN;
  resetBrowserOriginsForTests();
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(customerRoutes, { prefix: '/api/v1/customer' });
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await server.ready();
  app = server;
});

afterAll(async () => {
  const quiet = <T>(p: Promise<T>) => p.catch(() => undefined);
  await quiet(cleanupBillingClocks(app.prisma, subIds));
  await quiet(app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } }));
  await quiet(app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }));
  await quiet(app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } }));
  await quiet(app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }));
  // The CHECK allows clearing the pause in the same write as anything else, so cleanup never trips it.
  await quiet(app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }));
  await quiet(app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.supportTicket.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
  await app.close();
});

describe('[WEB-DELETE · owner ruling] a store owner\'s closure request pauses new orders at once', () => {
  it('from the website: every store the owner has stops taking new orders now, audited; a placed order is untouched; the ticket says the website', async () => {
    const p = await owner([{}, {}]);
    const customer = await app.prisma.user.findFirstOrThrow({ where: { customer: { isNot: null }, id: { notIn: userIds } }, select: { id: true } });
    const placed = await app.prisma.order.create({ data: {
      orderNumber: `CP-${nanoid(10).toUpperCase()}`, customerId: customer.id, vendorId: p.vendorIds[0]!, orderType: 'FOOD_DELIVERY', status: 'PREPARING',
      deliveryAddress: '1 Test St', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    } });
    orderIds.push(placed.id);
    const web = await signIn(p.phone, 'website');
    const res = await request(web);
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.json().data.message, 'the app shows this sentence').toMatch(/New orders at your store are paused now and your weekly fee stops; orders already placed still finish\.$/);
    const ticketId = res.json().data.ticketId as string;
    for (const id of p.vendorIds) {
      const s = await store(id);
      expect(s.acceptingOrders, 'new orders stop at once').toBe(false);
      expect(s.closurePausedAt).toBeInstanceOf(Date);
      expect(s.status, 'the store is paused, not suspended: its placed orders still finish').toBe('ACTIVE');
    }
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).status).toBe('PREPARING');
    const [paused] = await audits(ticketId, CLOSURE_ORDERS_PAUSED);
    expect(paused?.userId).toBe(p.userId);
    expect((paused?.changes as { stores: string[] }).stores.sort()).toEqual([...p.vendorIds].sort());
    const ticket = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect([ticket.subject, ticket.message]).toEqual([ACCOUNT_CLOSURE_SUBJECT, ACCOUNT_CLOSURE_MESSAGE_WEBSITE]);
    expect(ACCOUNT_CLOSURE_MESSAGE_WEBSITE).toMatch(/confirmed on the website\.$/);
    const check = await app.inject({ method: 'GET', url: '/api/v1/customer/account/deletion-check', headers: web });
    expect(check.json().data.closureRequest).toMatchObject({ ticketId, ordersPaused: true });
    // The same request again: one ticket, the stores' first pause kept, one pause record.
    expect((await request(web)).json().data.ticketId).toBe(ticketId);
    expect(await audits(ticketId, CLOSURE_ORDERS_PAUSED)).toHaveLength(1);
  });

  it('from the app (its DELETE): the same pause, through the same path; the ticket says the app', async () => {
    const p = await owner();
    const phone = await signIn(p.phone, 'app');
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/customer/account?receipts=v2', headers: phone });
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.json().data.status).toBe('CLOSURE_REQUESTED');
    expect(await store(p.vendorIds[0]!)).toMatchObject({ acceptingOrders: false, status: 'ACTIVE' });
    const ticket = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: res.json().data.ticketId } });
    expect(ticket.message).toBe(ACCOUNT_CLOSURE_MESSAGE);
    expect(await audits(ticket.id, CLOSURE_ORDERS_PAUSED)).toHaveLength(1);
  });

  it('while the request is open "Resume orders" is refused in plain words, and the database refuses any other writer', async () => {
    const p = await owner();
    const phone = await signIn(p.phone, 'app');
    expect((await request(phone)).statusCode).toBe(202);
    const refused = await resume(phone, p.vendorIds[0]!);
    expect(refused.statusCode, refused.payload).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'CLOSURE_REQUESTED', message: CLOSURE_PAUSE_REFUSAL });
    expect((await store(p.vendorIds[0]!)).acceptingOrders).toBe(false);
    await expect(app.prisma.vendor.update({ where: { id: p.vendorIds[0]! }, data: { acceptingOrders: true } }))
      .rejects.toThrow(/vendors_closure_pause_keeps_intake_off/);
  });

  it('a billing reinstatement lifts its own hold but never reopens a store the request paused', async () => {
    const p = await owner([{ status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false, isVerified: true }]);
    const phone = await signIn(p.phone, 'app');
    expect((await request(phone)).statusCode).toBe(202);
    expect((await store(p.vendorIds[0]!)).closurePausedAt).toBeInstanceOf(Date);
    await expect(app.prisma.$transaction((tx) => restoreBillingAccess(tx, p.vendorIds[0]!))).resolves.toBe(true);
    expect(await store(p.vendorIds[0]!)).toMatchObject({ status: 'ACTIVE', acceptingOrders: false });
  });

  it('cancelling the request (with a fresh code) resolves it, lifts the pause (audited) and lets the owner switch orders back on', async () => {
    const p = await owner();
    const web = await signIn(p.phone, 'website');
    const ticketId = (await request(web)).json().data.ticketId as string;
    const res = await cancel(web);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().data).toMatchObject({ cancelled: true, ticketId });
    expect(await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })).toMatchObject({ status: 'RESOLVED' });
    // Lifted, not resumed: intake stays off until the owner resumes it (the switch still checks the store).
    expect(await store(p.vendorIds[0]!)).toMatchObject({ closurePausedAt: null, acceptingOrders: false });
    expect(await audits(ticketId, ACCOUNT_CLOSURE_CANCELLED)).toHaveLength(1);
    const [lifted] = await audits(ticketId, CLOSURE_ORDERS_PAUSE_LIFTED);
    expect(lifted?.changes).toMatchObject({ by: 'OWNER_CANCELLED', stores: p.vendorIds });
    expect((await resume(web, p.vendorIds[0]!)).json().error?.code).not.toBe('CLOSURE_REQUESTED');
    await expect(app.prisma.vendor.update({ where: { id: p.vendorIds[0]! }, data: { acceptingOrders: true } })).resolves.toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/api/v1/customer/account/deletion-check', headers: web })).json().data.closureRequest).toBeNull();
    const again = await cancel(web);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('NO_CLOSURE_REQUEST');
  });

  it('cancelling needs the same fresh code as asking: an older session is refused and nothing changes', async () => {
    const p = await owner();
    const phone = await signIn(p.phone, 'app');
    const ticketId = (await request(phone)).json().data.ticketId as string;
    await app.prisma.session.updateMany({ where: { userId: p.userId }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    const res = await cancel(phone);
    expect(res.statusCode, res.payload).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe('OPEN');
    expect((await store(p.vendorIds[0]!)).closurePausedAt).toBeInstanceOf(Date);
  });

  it('Swift staff resolving the request in the support queue lifts the pause, audited, and the weekly fee resumes', async () => {
    const p = await owner();
    const sub = await fee(p.vendorIds[0]!);
    const phone = await signIn(p.phone, 'app');
    const ticketId = (await request(phone)).json().data.ticketId as string;
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).autoRenew).toBe(false);
    const staff = await app.prisma.user.create({ data: { phone: `+${phoneBase + 90_000 + seq}`, firstName: 'Support', lastName: 'Staff', roles: ['ADMIN'], activeRole: 'ADMIN' } });
    userIds.push(staff.id);
    await new SupportService(app.prisma, new NotificationService(app.prisma, app.io)).resolve(ticketId, staff.id, { status: 'RESOLVED', resolution: 'ANSWERED', adminNote: 'Closed at the owner\'s request by phone.' });
    expect((await store(p.vendorIds[0]!)).closurePausedAt).toBeNull();
    const [lifted] = await audits(ticketId, CLOSURE_ORDERS_PAUSE_LIFTED);
    expect(lifted).toMatchObject({ userId: staff.id, changes: { by: 'STAFF_RESOLVED', accountId: p.userId } });
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).autoRenew, 'the fee resumes when the request ends').toBe(true);
  });

  it('a typed ticket with the closure subject, resolved by staff, lifts nothing: only the confirmed request does', async () => {
    const p = await owner();
    const phone = await signIn(p.phone, 'app');
    expect((await request(phone)).statusCode).toBe(202);
    const typed = await app.prisma.supportTicket.create({ data: { userId: p.userId, category: 'ACCOUNT', subject: ACCOUNT_CLOSURE_SUBJECT, message: 'Typed by hand.' } });
    const staff = await app.prisma.user.create({ data: { phone: `+${phoneBase + 80_000 + seq}`, firstName: 'Support', lastName: 'Typed', roles: ['ADMIN'], activeRole: 'ADMIN' } });
    userIds.push(staff.id);
    await new SupportService(app.prisma, new NotificationService(app.prisma, app.io)).resolve(typed.id, staff.id, { status: 'RESOLVED', resolution: 'ANSWERED' });
    expect((await store(p.vendorIds[0]!)).closurePausedAt, 'the real request still holds the pause').toBeInstanceOf(Date);
    expect(await audits(typed.id, CLOSURE_ORDERS_PAUSE_LIFTED)).toHaveLength(0);
  });
});

/** A store's weekly fee: ACTIVE, auto-renewing, a paid week still running unless `paidUntil` says otherwise. */
async function fee(vendorId: string, over: { autoRenew?: boolean; paidUntil?: Date } = {}) {
  const end = over.paidUntil ?? new Date(Date.now() + 3 * DAY);
  const start = new Date(end.getTime() - 7 * DAY);
  const sub = await app.prisma.subscription.create({ data: {
    vendorId, type: 'RESTAURANT', weeklyRate: 20000, status: 'ACTIVE', billingMethod: 'CASH', autoRenew: over.autoRenew ?? true,
    currentPeriodStart: start, currentPeriodEnd: end, nextBillingDate: end, prepaidBalance: { create: { balance: 20000 } },
  } });
  subIds.push(sub.id);
  const paymentRef = `wd-paid:${sub.id}`;
  await app.prisma.subscriptionPayment.create({ data: { subscriptionId: sub.id, amount: 20000, paymentMethod: 'CASH', status: 'CAPTURED', periodStart: start, periodEnd: end, paidAt: start, externalRef: paymentRef } });
  await app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: 20000, currencyCode: 'GYD', paymentRef, idempotencyKey: `success:${sub.id}:${start.toISOString().slice(0, 10)}` } });
  return sub;
}
const subRow = (id: string) => app.prisma.subscription.findUniqueOrThrow({ where: { id } });
const payments = (id: string) => app.prisma.subscriptionPayment.count({ where: { subscriptionId: id } });

describe('[WEB-DELETE · owner ruling 2 Nov] the weekly fee stops from the moment the closure is requested', () => {
  it('the request holds every store fee at once (no new week charged or retried), audited and keyed to the request; a paid week still runs', async () => {
    const p = await owner([{}, {}]);
    const a = await fee(p.vendorIds[0]!);
    const b = await fee(p.vendorIds[1]!);
    const ticketId = (await request(await signIn(p.phone, 'website'))).json().data.ticketId as string;
    for (const s of [a, b]) {
      const row = await subRow(s.id);
      expect(row).toMatchObject({ autoRenew: false, nextRetryAt: null, status: 'ACTIVE' });
      expect(row.nextBillingDate, 'the paid week keeps its end').toEqual(s.nextBillingDate);
      expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.id, note: CLOSURE_FEE_HOLD_NOTE, idempotencyKey: { contains: ticketId } } })).toBe(1);
      expect(await app.prisma.auditLog.count({ where: { entity: 'Subscription', entityId: s.id, action: BILLING_HELD_FOR_CLOSURE } })).toBe(1);
      expect(await payments(s.id), 'nothing already paid is refunded or charged').toBe(1);
    }
  });

  it('cancelling resumes the held fee from then: a still-paid week renews on its own date, nothing is charged twice', async () => {
    const p = await owner();
    const s = await fee(p.vendorIds[0]!);
    const web = await signIn(p.phone, 'website');
    expect((await request(web)).statusCode).toBe(202);
    const res = await cancel(web);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().data).toMatchObject({ feesResumed: 1 });
    expect(res.json().data.message).toMatch(/Your weekly fee starts again from today\./);
    const row = await subRow(s.id);
    expect(row).toMatchObject({ autoRenew: true, status: 'ACTIVE' });
    expect(row.nextBillingDate).toEqual(s.nextBillingDate);
    expect(await payments(s.id)).toBe(1);
    expect(await app.prisma.auditLog.count({ where: { entity: 'Subscription', entityId: s.id, action: BILLING_RESUMED_AFTER_CLOSURE } })).toBe(1);
  });

  it('a paid week that ended while the fee was held lapses owing nothing; cancelling restarts it due now with exactly one new week', async () => {
    const p = await owner();
    const s = await fee(p.vendorIds[0]!, { paidUntil: new Date(Date.now() - 2 * DAY) });
    const web = await signIn(p.phone, 'website');
    expect((await request(web)).statusCode).toBe(202);
    const billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
    await billing.lapseStoppedSubscriptions();
    expect((await subRow(s.id)).status, 'no new week fell due while the request was open').toBe('PAUSED');
    expect(await payments(s.id)).toBe(1);
    const before = Date.now();
    const res = await cancel(web);
    expect(res.statusCode, res.payload).toBe(200);
    const row = await subRow(s.id);
    expect(row).toMatchObject({ status: 'ACTIVE', autoRenew: true });
    expect(row.currentPeriodStart.getTime(), 'the new week starts when the request was cancelled').toBeGreaterThanOrEqual(before - 1000);
    expect(row.currentPeriodEnd.getTime() - row.currentPeriodStart.getTime()).toBe(7 * DAY);
    expect(await payments(s.id), 'exactly one new week').toBe(2);
  });

  it('a fee the partner had already stopped is not touched by the request, and not resumed by the cancel', async () => {
    const p = await owner();
    const s = await fee(p.vendorIds[0]!, { autoRenew: false });
    const web = await signIn(p.phone, 'website');
    expect((await request(web)).statusCode).toBe(202);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: s.id, note: CLOSURE_FEE_HOLD_NOTE } })).toBe(0);
    expect((await cancel(web)).json().data).toMatchObject({ feesResumed: 0 });
    expect((await subRow(s.id)).autoRenew).toBe(false);
  });
});

describe('[WEB-DELETE · REVIEW-F #2304 S3-1] the "Resume orders" refusal says the right thing to the right person', () => {
  it('the owner is pointed to the website or support (the app has no cancel); a team member is told the owner asked', async () => {
    const p = await owner();
    const phone = await signIn(p.phone, 'app');
    expect((await request(phone)).statusCode).toBe(202);
    const mine = await resume(phone, p.vendorIds[0]!);
    expect(mine.json().error).toMatchObject({ code: 'CLOSURE_REQUESTED', message: CLOSURE_PAUSE_REFUSAL });
    expect(CLOSURE_PAUSE_REFUSAL).toMatch(/swiftgy\.com.*or contact Swift support\.$/);
    seq += 1;
    const member = await app.prisma.user.create({ data: { phone: `+${phoneBase + 70_000 + seq}`, firstName: 'Floor', lastName: 'Staff', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } } });
    userIds.push(member.id);
    await app.prisma.vendorStaff.create({ data: { vendorId: p.vendorIds[0]!, userId: member.id, role: 'MANAGER', invitedBy: p.userId } });
    const theirs = await resume(await signIn(member.phone, 'app'), p.vendorIds[0]!);
    expect(theirs.json().error).toMatchObject({ code: 'CLOSURE_REQUESTED', message: CLOSURE_PAUSE_REFUSAL_TEAM });
    expect(CLOSURE_PAUSE_REFUSAL_TEAM).not.toMatch(/you asked/i);
  });
});
