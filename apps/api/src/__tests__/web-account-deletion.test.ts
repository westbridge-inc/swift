import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { customerRoutes } from '../modules/user/customer.routes';
import { ACCESS_COOKIE, REFRESH_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { BLOCKER_MESSAGE } from '../modules/user/partner-wind-down';
import { requestOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner 1 Nov 2026] A person who signed up on the website deletes
// their own account there (stores, riders and drivers have no app yet, and
// before launch the app talks to staging).
//
// The website's session is an HttpOnly cookie pair (W-01): the existing
// DELETE /customer/account serves it as it serves the app, behind the same
// fresh-code rule, and /auth/logout/refresh expires the dead cookies after.
// What the website also needs is to SHOW which live orders and jobs, and which
// money, stop the delete before the person asks for a code. That is
// GET /customer/account/deletion-check: the deletion's own rules (one
// definition of live work, the partner obligations and their words), read
// without a lock or a write. The delete re-checks everything under its locks.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const ORIGIN = 'http://localhost:3001';
const BROWSER = { 'x-swift-client': 'web', origin: ORIGIN } as const;
const userIds: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];
const jobIds: string[] = [];
let seq = 0;
const phoneBase = 592_018_400_000 + Math.floor(Math.random() * 90_000);

type Jar = Record<string, string>;
/** A browser's cookie jar: every Set-Cookie applied in order (Max-Age=0 deletes). */
function applySetCookies(jar: Jar, res: { headers: Record<string, unknown> }): void {
  for (const line of ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? [])) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const at = pair!.indexOf('=');
    const name = pair!.slice(0, at);
    const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
    if (maxAge && Number(maxAge.split('=')[1]) <= 0) delete jar[name];
    else jar[name] = decodeURIComponent(pair!.slice(at + 1));
  }
}
const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

async function person(roles: UserRole[], opts: { committedFloat?: number } = {}) {
  seq += 1;
  const phone = `+${phoneBase + seq}`;
  const user = await app.prisma.user.create({ data: {
    phone, firstName: 'Web', lastName: `Delete${seq}`, email: `webdelete${seq}-${nanoid(6)}@example.com`,
    roles, activeRole: roles[0]!, isPhoneVerified: true, customer: { create: {} },
    ...(roles.includes('MOVER') && { rider: { create: { riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', committedFloat: opts.committedFloat ?? 0 } } }),
  } });
  userIds.push(user.id);
  return { userId: user.id, phone };
}

/** The website's sign-in: a code, then the session as cookies (no token in the body). */
async function browserSignIn(phone: string): Promise<Jar> {
  const code = await requestOtp(app, phone);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers: BROWSER, payload: { phone, code } });
  expect(res.statusCode, res.payload).toBe(200);
  const jar: Jar = {};
  applySetCookies(jar, res);
  expect(jar[ACCESS_COOKIE], 'the website holds its session as a cookie').toBeTruthy();
  return jar;
}

const asBrowser = (jar: Jar, method: 'GET' | 'POST' | 'DELETE', url: string) =>
  app.inject({ method, url, headers: { ...BROWSER, cookie: cookieHeader(jar) } });
const check = (jar: Jar) => asBrowser(jar, 'GET', '/api/v1/customer/account/deletion-check');
const del = (jar: Jar) => asBrowser(jar, 'DELETE', '/api/v1/customer/account?receipts=v2');

/** Born in `status` (the database refuses moving an order back across the machine). */
async function order(over: { customerId?: string; riderId?: string | null; vendorId?: string; status: OrderStatus }) {
  const vendorId = over.vendorId ?? (await app.prisma.vendor.findFirstOrThrow({ where: { id: { notIn: vendorIds } }, select: { id: true } })).id;
  const customerId = over.customerId
    ?? (await app.prisma.user.findFirstOrThrow({ where: { customer: { isNot: null }, id: { notIn: userIds } }, select: { id: true } })).id;
  const row = await app.prisma.order.create({ data: {
    orderNumber: `WD-${nanoid(10).toUpperCase()}`, customerId, vendorId, riderId: over.riderId ?? null,
    orderType: 'FOOD_DELIVERY', status: over.status, deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
  } });
  orderIds.push(row.id);
  return row;
}

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
  await registerAuthRoutes(server);
  await server.register(customerRoutes, { prefix: '/api/v1/customer' });
  await server.ready();
  app = server;
});

afterAll(async () => {
  const quiet = <T>(p: Promise<T>) => p.catch(() => undefined);
  await quiet(app.prisma.serviceJob.deleteMany({ where: { id: { in: jobIds } } }));
  await quiet(app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }));
  await quiet(app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }));
  await quiet(app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.supportTicket.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }));
  await quiet(app.prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
  await app.close();
});

describe('[WEB-DELETE] the website deletes an account with its cookie session', () => {
  it('a browser signed in with a code deletes its own account; the cookies it still holds name no session and are expired', async () => {
    const p = await person(['CUSTOMER']);
    const jar = await browserSignIn(p.phone);
    const res = await del(jar);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().data).toMatchObject({ deleted: true });
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ phone: `deleted:${p.userId}`, status: 'DEACTIVATED', firstName: 'Deleted' });
    expect(await app.prisma.session.count({ where: { userId: p.userId } }), 'every sign-in, on every device, is gone').toBe(0);
    const me = await asBrowser(jar, 'GET', '/api/v1/auth/me');
    expect(me.statusCode, 'the dead cookie is no credential').toBe(401);
    // The website's last step: the server expires both cookies, with no live session needed.
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout/refresh', headers: { ...BROWSER, cookie: cookieHeader(jar), 'content-type': 'application/json' }, payload: {} });
    expect(out.statusCode, out.payload).toBe(200);
    applySetCookies(jar, out);
    expect(jar[ACCESS_COOKIE]).toBeUndefined();
    expect(jar[REFRESH_COOKIE]).toBeUndefined();
  });

  it('an older browser session is asked for a fresh code (the refusal the website opens its code dialog on), and nothing changes', async () => {
    const p = await person(['CUSTOMER']);
    const jar = await browserSignIn(p.phone);
    await app.prisma.session.updateMany({ where: { userId: p.userId }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    const res = await del(jar);
    expect(res.statusCode, res.payload).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { stepUp: { send: 'POST /auth/step-up', verify: 'POST /auth/step-up/verify' } } });
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ status: 'ACTIVE', firstName: 'Web' });
  });
});

describe('[WEB-DELETE] GET /customer/account/deletion-check shows what stops the delete, by the delete\'s own rules', () => {
  it('lists the live orders on every side the person is on, and Delete refuses on exactly those', async () => {
    const p = await person(['CUSTOMER', 'MOVER']);
    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { userId: p.userId }, select: { id: true } });
    const mine = await order({ customerId: p.userId, status: 'PENDING' });
    const carrying = await order({ riderId: rider.id, status: 'PICKED_UP' });
    await order({ customerId: p.userId, status: 'DELIVERED' }); // finished: never listed
    const decoy = await order({ status: 'PENDING' }); // [REVIEW-G #2304 S3-1] a stranger's live order: never listed
    const jar = await browserSignIn(p.phone);

    const before = await check(jar);
    expect(before.statusCode, before.payload).toBe(200);
    const data = before.json().data;
    expect(data.closure).toBe('DELETE');
    expect(data.ownsStore).toBe(false);
    expect(data.settleFirst).toBeNull();
    expect(data.openOrders.count).toBe(2);
    expect(data.openOrders.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mine.id, orderNumber: mine.orderNumber, status: 'PENDING', side: 'CUSTOMER' }),
      expect.objectContaining({ id: carrying.id, orderNumber: carrying.orderNumber, status: 'PICKED_UP', side: 'RIDER' }),
    ]));
    expect(data.openOrders.items).toHaveLength(2);
    expect(data.openOrders.items.map((i: { id: string }) => i.id), 'a stranger\'s live order is never listed').not.toContain(decoy.id);
    // Only the person's own view of each order travels: no other person's id, name or number.
    expect(JSON.stringify(data)).not.toMatch(/customerId|riderId|phone/);

    const refused = await del(jar);
    expect(refused.statusCode, refused.payload).toBe(409);
    expect(refused.json().error.code).toBe('ACTIVE_ORDERS');

    await app.prisma.order.update({ where: { id: mine.id }, data: { status: 'CANCELLED' } });
    await app.prisma.order.update({ where: { id: carrying.id }, data: { status: 'DELIVERED' } });
    const after = (await check(jar)).json().data;
    expect(after.openOrders).toEqual({ count: 0, items: [] });
    expect((await del(jar)).statusCode).toBe(200);
  });

  it('lists a live service job, as the customer or as the provider', async () => {
    const p = await person(['CUSTOMER']);
    const provider = await app.prisma.serviceProvider.create({ data: { userId: p.userId, trade: 'Synthetic trade', portfolioPhotos: [] } });
    const other = await app.prisma.user.findFirstOrThrow({ where: { customer: { isNot: null }, id: { notIn: userIds } }, select: { id: true } });
    const job = await app.prisma.serviceJob.create({ data: { customerId: other.id, providerId: provider.id, description: 'Synthetic job', photos: [], status: 'REQUESTED' } });
    jobIds.push(job.id);
    const jar = await browserSignIn(p.phone);
    const data = (await check(jar)).json().data;
    expect(data.openServiceJobs).toEqual({ count: 1, items: [expect.objectContaining({ id: job.id, status: 'REQUESTED', side: 'PROVIDER' })] });
    expect((await del(jar)).json().error.code).toBe('ACTIVE_SERVICE_JOBS');
    await app.prisma.serviceJob.update({ where: { id: job.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    expect((await check(jar)).json().data.openServiceJobs).toEqual({ count: 0, items: [] });
  });

  it('tells a rider holding a store\'s cash what to settle first, in the deletion\'s own words', async () => {
    const p = await person(['MOVER'], { committedFloat: 500 });
    const jar = await browserSignIn(p.phone);
    const data = (await check(jar)).json().data;
    expect(data.settleFirst).toEqual({ blockers: ['CASH_HELD'], message: BLOCKER_MESSAGE.CASH_HELD });
    const refused = await del(jar);
    expect(refused.json().error).toMatchObject({ code: 'PARTNER_OBLIGATIONS', message: BLOCKER_MESSAGE.CASH_HELD });
  });

  it('tells a store owner the account closes by a request the team completes, lists the store\'s live orders, and shows the request once sent; the store\'s new orders pause, it stays live', async () => {
    const p = await person(['VENDOR_OWNER', 'CUSTOMER']);
    const owner = await app.prisma.vendorOwner.create({ data: { userId: p.userId } });
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: 'Synthetic web-delete store', slug: `wd-${nanoid(12).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: 'synthetic', addressLine1: 'Synthetic', city: 'Synthetic', region: 'Synthetic', latitude: 0, longitude: 0,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: false,
    } });
    vendorIds.push(vendor.id);
    const live = await order({ vendorId: vendor.id, status: 'PREPARING' });
    const jar = await browserSignIn(p.phone);

    const first = (await check(jar)).json().data;
    expect(first.closure).toBe('REQUEST');
    expect(first.ownsStore).toBe(true);
    expect(first.closureRequest).toBeNull();
    expect(first.openOrders.items).toEqual([expect.objectContaining({ id: live.id, side: 'STORE', storeName: 'Synthetic web-delete store' })]);

    const sent = await asBrowser(jar, 'POST', '/api/v1/customer/account/closure-request');
    expect(sent.statusCode, sent.payload).toBe(202);
    const ticketId = sent.json().data.ticketId as string;
    const second = (await check(jar)).json().data;
    expect(second.closureRequest).toMatchObject({ ticketId, status: 'OPEN', ordersPaused: true });
    expect(typeof second.closureRequest.requestedAt).toBe('string');
    // A request is not a deletion: the person keeps access and the store stays live, its NEW orders paused
    // (owner ruling 1 Nov; closure-request-pause.test.ts) and its live order still listed to finish.
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).toMatchObject({ status: 'ACTIVE', acceptingOrders: false });
    expect(second.openOrders.items).toEqual([expect.objectContaining({ id: live.id, status: 'PREPARING' })]);
    expect(await app.prisma.session.count({ where: { userId: p.userId } })).toBe(1);
  });

  it('a person signed out gets no answer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/customer/account/deletion-check', headers: BROWSER });
    expect(res.statusCode).toBe(401);
  });
});
