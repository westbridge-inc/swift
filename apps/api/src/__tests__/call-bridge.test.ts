/**
 * [O-1 · owner 22-24 Oct 2026] The Swift call bridge on the real routes and a
 * real database. The provider is the REAL Twilio adapter over a stubbed fetch:
 * nothing reaches a network, and the request it would have sent is asserted.
 * Every webhook is signed exactly as Twilio signs (full URL + form).
 *
 * Every party has a real, distinct number from testPhone() (the run-wide
 * fictional +59206 block), so a number anywhere it must not be is a leak.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { callsRoutes, callVoiceRoutes, INBOUND_CALL_WORDS } from '../modules/calls/calls.routes';
import { TwilioVoiceProvider } from '../providers/voice/twilio-voice';
import { twilioSignature } from '../modules/notification/sms-inbound.routes';
import { CALL_WORDS } from '../modules/calls/call-bridge';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { testPhone } from './helpers/fixture-ids';

grantSuiteCapability('unscoped-mutation');

/** fetch's own init type (the DOM name is not a lint global here). */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const TOKEN = 'bridge-test-webhook-token';
const SID = `AC${'1'.repeat(32)}`;
const KEY = `SK${'2'.repeat(32)}`;
const CALLER_ID = '+15005550006';
const BASE = 'https://api.example.test/api/v1/calls/voice';
const ENV = {
  CALL_RELAY: '1', CALL_RELAY_CALLER_ID: CALLER_ID, CALL_RELAY_WEBHOOK_BASE: BASE, CALL_RELAY_MAX_ATTEMPTS_PER_ORDER: '3',
  TWILIO_ACCOUNT_SID: SID, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: 'bridge-test-secret', TWILIO_WEBHOOK_AUTH_TOKEN: TOKEN,
};
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'call-bridge-test');

/** What the stubbed Twilio was asked to do, and what it answers next. */
const placed: URLSearchParams[] = [];
let twilioAnswers: 'ok' | 'refuse' = 'ok';
const http = (async (_url: string, init: FetchInit) => {
  placed.push(new URLSearchParams(String(init.body)));
  if (twilioAnswers === 'refuse') return new Response('{}', { status: 400 });
  return new Response(JSON.stringify({ sid: `CA${nanoid(32).replace(/[^a-f0-9]/gi, 'a').slice(0, 32).padEnd(32, 'a')}` }), { status: 201 });
}) as unknown as typeof fetch;

let app: FastifyInstance;
const users: string[] = [];
const orderIds: string[] = [];

type Person = { id: string; token: string; phone: string };
async function person(n: number, roles: string[], active: string, extra: Record<string, unknown> = {}): Promise<Person> {
  const phone = testPhone();
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone, firstName: 'Bridge', lastName: `Party${n}`, roles: roles as never, activeRole: active as never,
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId: 'swift-default', ...extra,
  } as never }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: active, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `bridge-${n}-${NUM}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: u.id, token, phone };
}

const money = { subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, tipAmount: 0, totalAmount: 3500, paymentMethod: 'CASH' };
async function order(data: Record<string, unknown>) {
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `CBR${NUM}${nanoid(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
    pickupAddress: 'Bridge Pickup', pickupLat: 6.8021, pickupLng: -58.1561,
    deliveryAddress: '1 Bridge St', deliveryLat: 6.8121, deliveryLng: -58.1461,
    ...money, ...data,
  } as never }));
  orderIds.push(o.id);
  return o;
}

let diner: Person, riderP: Person, sender: Person, courierP: Person, owner: Person, staff: Person, passenger: Person, driverP: Person, stranger: Person;
let riderId = '', courierRiderId = '', driverId = '', vendorId = '';
const STORE_LINE = testPhone();
const RECIPIENT = testPhone();
const allPhones = () => [diner, riderP, sender, courierP, owner, staff, passenger, driverP, stranger].map((p) => p.phone).concat(STORE_LINE, RECIPIENT);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  const provider = (config: { twilio: ConstructorParameters<typeof TwilioVoiceProvider>[0] }) => new TwilioVoiceProvider(config.twilio, http);
  await app.register(callsRoutes, { prefix: '/api/v1/calls', provider });
  await app.register(callVoiceRoutes, { prefix: '/api/v1/calls/voice', provider });
  await app.ready();

  diner = await person(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  sender = await person(2, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  passenger = await person(3, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  riderP = await person(4, ['RIDER', 'CUSTOMER'], 'RIDER');
  courierP = await person(5, ['RIDER', 'CUSTOMER'], 'RIDER');
  driverP = await person(6, ['MOVER', 'CUSTOMER'], 'MOVER');
  owner = await person(7, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  staff = await person(8, ['CUSTOMER'], 'CUSTOMER'); // a store team member is a customer account with a VendorStaff seat
  stranger = await person(9, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });

  riderId = (await system(() => app.prisma.rider.create({ data: { userId: riderP.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
  courierRiderId = (await system(() => app.prisma.rider.create({ data: { userId: courierP.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
  driverId = (await system(() => app.prisma.driver.create({ data: {
    userId: driverP.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver',
    licensePlate: `PCB ${NUM}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } }))).id;
  const vo = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: owner.id, vendors: { create: {
    name: `Bridge Diner ${NUM}`, slug: `bridge-diner-${NUM}-${nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, vendorType: 'RESTAURANT',
    phone: STORE_LINE, addressLine1: '2 Bridge St', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8021, longitude: -58.1561, status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
  } } }, include: { vendors: true } }));
  vendorId = vo.vendors[0]!.id;
  await system(() => app.prisma.vendorStaff.create({ data: { vendorId, userId: staff.id, role: 'STAFF', invitedBy: owner.id } as never }));
});

afterAll(async () => {
  await system(async () => {
    if (orderIds.length) {
      await app.prisma.callSession.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: users } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  placed.length = 0;
  twilioAnswers = 'ok';
});
afterEach(() => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const bridge = (token: string, orderId: string, target: string) =>
  app.inject({ method: 'POST', url: '/api/v1/calls/bridge', headers: { authorization: `Bearer ${token}` }, payload: { orderId, target } });

/** Post a webhook exactly as Twilio would: form body, signature over the public URL + form. */
function hook(step: string, sessionId: string, form: Record<string, string> = {}, opts: { sign?: 'ok' | 'none' | 'wrong-url' } = {}) {
  const fields = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, [v]]));
  const query = `?s=${encodeURIComponent(sessionId)}`;
  const signedUrl = opts.sign === 'wrong-url' ? `${BASE}/${step}?s=someone-else` : `${BASE}/${step}${query}`;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.sign !== 'none') headers['x-twilio-signature'] = twilioSignature(TOKEN, signedUrl, fields);
  return app.inject({ method: 'POST', url: `/api/v1/calls/voice/${step}${query}`, headers, payload: new URLSearchParams(form).toString() });
}

const session = (id: string) => system(() => app.prisma.callSession.findUniqueOrThrow({ where: { id } }));
const callNotices = (userId: string) => system(() => app.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }))
  .then((rows) => rows.filter((r) => (r.data as { kind?: string } | null)?.kind === 'call_incoming'));
const liveFood = () => order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: diner.id, vendorId, riderId, status: 'PICKED_UP', acceptedAt: new Date() });

describe('[O-1] CALL_RELAY off (the launch state): nothing is dialled, written or pushed', () => {
  it('the bridge refuses, GET /config says off and shows no number', async () => {
    delete process.env['CALL_RELAY'];
    const o = await liveFood();
    const res = await bridge(diner.token, o.id, 'rider');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CALL_RELAY_OFF');
    expect(placed).toHaveLength(0);
    expect(await system(() => app.prisma.callSession.count({ where: { orderId: o.id } }))).toBe(0);
    expect(await callNotices(diner.id)).toHaveLength(0);
    const cfg = await app.inject({ method: 'GET', url: '/api/v1/calls/config', headers: { authorization: `Bearer ${diner.token}` } });
    expect(cfg.json().data).toEqual({ enabled: false, callerId: null });
    for (const v of ['0', '', 'true', '2']) {
      process.env['CALL_RELAY'] = v;
      expect((await bridge(diner.token, o.id, 'rider')).statusCode, `CALL_RELAY=${v}`).toBe(403);
    }
    expect(placed).toHaveLength(0);
  });

  it('signed-out: 401 on both doors', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/calls/config' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/bridge', payload: { orderId: 'x', target: 'rider' } })).statusCode).toBe(401);
  });
});

describe('[O-1] starting a call', () => {
  it('GET /config with the bridge on: enabled, and Swift\'s number for the save-number tip', async () => {
    const cfg = await app.inject({ method: 'GET', url: '/api/v1/calls/config', headers: { authorization: `Bearer ${riderP.token}` } });
    expect(cfg.json().data).toEqual({ enabled: true, callerId: CALLER_ID });
  });

  it('rings the CALLER first, from Swift\'s number, with the step URLs; the row holds no number; the caller is told by push', async () => {
    const o = await liveFood();
    const res = await bridge(diner.token, o.id, 'rider');
    expect(res.statusCode, res.body).toBe(200);
    const { callId, status } = res.json().data;
    expect(status).toBe('DIALING_CALLER');
    for (const p of allPhones()) expect(res.body.includes(p)).toBe(false);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.get('To')).toBe(diner.phone);
    expect(placed[0]!.get('From')).toBe(CALLER_ID);
    expect(placed[0]!.get('Url')).toBe(`${BASE}/leg1?s=${callId}`);
    expect(placed[0]!.get('StatusCallback')).toBe(`${BASE}/status?s=${callId}`);
    expect(placed[0]!.get('Record')).toBe('false');
    expect(placed[0]!.get('TimeLimit')).toBe('1800');
    const row = await session(callId);
    expect(row).toMatchObject({ orderId: o.id, callerUserId: diner.id, callerRole: 'customer', calleeRole: 'rider', provider: 'twilio', status: 'DIALING_CALLER' });
    expect(row.providerCallId).toMatch(/^CA[0-9a-fA-F]{32}$/);
    for (const p of allPhones()) expect(JSON.stringify(row).includes(p)).toBe(false);
    const notices = await callNotices(diner.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.data).toMatchObject({ kind: 'call_incoming', callOrderId: o.id, from: 'rider', leg: 1, audience: 'customer' });
    expect((notices[0]!.data as Record<string, unknown>)['orderId']).toBeUndefined();
    expect(notices[0]!.body).toMatch(/Swift is calling you now about your order .+, to connect you with your rider\. Answer, then press 1\./);
    for (const p of allPhones()) expect(JSON.stringify(notices[0]).includes(p)).toBe(false);
    expect(JSON.stringify(notices[0])).not.toMatch(/Bridge|Party/); // no names
    // close it so the order's live slot is free for the next test
    await hook('status', callId, { CallStatus: 'completed', CallDuration: '3' });
  });

  it('not a party to the order is answered like no order at all', async () => {
    const o = await liveFood();
    expect((await bridge(stranger.token, o.id, 'rider')).statusCode).toBe(404);
    expect((await bridge(stranger.token, 'cnotanorder000000000000000', 'rider')).statusCode).toBe(404);
    expect(placed).toHaveLength(0);
  });

  it('a finished order, a pair the order cannot have, and a missing number are refused before anything is dialled', async () => {
    const done = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: diner.id, vendorId, riderId, status: 'DELIVERED', acceptedAt: new Date() });
    const finished = await bridge(diner.token, done.id, 'rider');
    expect([finished.statusCode, finished.json().error.code]).toEqual([409, 'CALL_ORDER_NOT_LIVE']);
    const o = await liveFood();
    for (const target of ['driver', 'recipient', 'customer']) {
      const res = await bridge(diner.token, o.id, target);
      expect([target, res.statusCode, res.json().error.code]).toEqual([target, 400, 'CALL_TARGET_INVALID']);
    }
    const unassigned = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: diner.id, vendorId, status: 'PREPARING', acceptedAt: new Date() });
    const none = await bridge(diner.token, unassigned.id, 'rider');
    expect([none.statusCode, none.json().error.code]).toEqual([409, 'CALL_NO_NUMBER']);
    expect(placed).toHaveLength(0);
  });

  it('stores are in scope: the owner and a staff member call the rider or the customer; the rider calls the store', async () => {
    const o = await liveFood();
    const ownerNoticesBefore = (await callNotices(owner.id)).length;
    const a = await bridge(staff.token, o.id, 'rider');
    expect(a.statusCode, a.body).toBe(200);
    expect(placed.at(-1)!.get('To')).toBe(staff.phone);
    expect((await session(a.json().data.callId)).callerRole).toBe('store');
    // leg 1 rings the staff member, so THEY are told, on their store screens; the owner is not
    expect((await callNotices(staff.id)).at(-1)!.data).toMatchObject({ kind: 'call_incoming', leg: 1, audience: 'business', from: 'rider' });
    expect((await callNotices(owner.id)).length).toBe(ownerNoticesBefore);
    await hook('status', a.json().data.callId, { CallStatus: 'completed' });
    const b = await bridge(owner.token, o.id, 'customer');
    expect(b.statusCode, b.body).toBe(200);
    expect(placed.at(-1)!.get('To')).toBe(owner.phone);
    await hook('status', b.json().data.callId, { CallStatus: 'completed' });
    const o2 = await liveFood();
    const c = await bridge(riderP.token, o2.id, 'store');
    expect(c.statusCode, c.body).toBe(200);
    // leg 2 rings the store's line (no published number here)
    await hook('leg1', c.json().data.callId, {});
    const dial = await hook('leg1-gather', c.json().data.callId, { Digits: '1' });
    expect(dial.body).toContain(`>${STORE_LINE}</Number>`);
    await hook('dial-done', c.json().data.callId, { DialCallStatus: 'no-answer' });
  });

  it('the courier rider can have Swift call the parcel recipient; the sender cannot', async () => {
    const parcel = await order({ orderType: 'COURIER', customerId: sender.id, riderId: courierRiderId, status: 'PICKED_UP', courierRecipientPhone: RECIPIENT, acceptedAt: new Date() });
    expect((await bridge(sender.token, parcel.id, 'recipient')).json().error.code).toBe('CALL_TARGET_INVALID');
    const res = await bridge(courierP.token, parcel.id, 'recipient');
    expect(res.statusCode, res.body).toBe(200);
    await hook('leg1', res.json().data.callId, {});
    const dial = await hook('leg1-gather', res.json().data.callId, { Digits: '1' });
    expect(dial.body).toContain(`>${RECIPIENT}</Number>`);
    await hook('dial-done', res.json().data.callId, { DialCallStatus: 'busy' });
  });

  it('a taxi: the passenger calls the driver', async () => {
    const ride = await order({ orderType: 'TAXI', customerId: passenger.id, driverId, status: 'DRIVER_EN_ROUTE', ridePin: '123456' });
    const res = await bridge(passenger.token, ride.id, 'driver');
    expect(res.statusCode, res.body).toBe(200);
    expect(placed.at(-1)!.get('To')).toBe(passenger.phone);
    expect((await bridge(passenger.token, ride.id, 'rider')).json().error.code).toBe('CALL_TARGET_INVALID');
    await hook('status', res.json().data.callId, { CallStatus: 'no-answer' });
  });

  it('one live call per order: a second tap while the first rings is refused', async () => {
    const o = await liveFood();
    const first = await bridge(diner.token, o.id, 'rider');
    expect(first.statusCode).toBe(200);
    const second = await bridge(riderP.token, o.id, 'customer');
    expect([second.statusCode, second.json().error.code]).toEqual([409, 'CALL_IN_PROGRESS']);
    expect(placed).toHaveLength(1);
    await hook('status', first.json().data.callId, { CallStatus: 'completed' });
    expect((await bridge(riderP.token, o.id, 'customer')).statusCode).toBe(200);
  });

  it('two taps at the same moment start exactly one call and write one row', async () => {
    const o = await liveFood();
    const [a, b] = await Promise.all([bridge(diner.token, o.id, 'rider'), bridge(riderP.token, o.id, 'customer')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await system(() => app.prisma.callSession.count({ where: { orderId: o.id } }))).toBe(1);
    expect(placed).toHaveLength(1);
    const live = a.statusCode === 200 ? a : b;
    await hook('status', live.json().data.callId, { CallStatus: 'completed' });
  });

  // [REVIEW-M S4-2 · REVIEW-G2 S4-3] Starting a call takes the order's row lock first, so the attempt count and the
  // insert of one start can never interleave with another start's: while someone else holds the order row, a start waits.
  it('a start waits for the order row: the attempt count and the insert are one step per order', async () => {
    const o = await liveFood();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => { locked = r; });
    // FOR NO KEY UPDATE: it blocks the start's FOR UPDATE but not the foreign-key check of the call row it
    // inserts (FOR KEY SHARE), so only the start's own lock can make it wait here.
    const holder = system(() => app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${o.id} FOR NO KEY UPDATE`;
      locked();
      await held;
    }, { timeout: 20_000 }));
    await gotLock;
    const start = bridge(diner.token, o.id, 'rider');
    const first = await Promise.race([start.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 1500))]);
    expect(first, 'the start must wait for the order row').toBe('waiting');
    expect(placed).toHaveLength(0);
    release();
    await holder;
    const res = await start;
    expect(res.statusCode, res.body).toBe(200);
    expect(placed).toHaveLength(1);
    await hook('status', res.json().data.callId, { CallStatus: 'completed' });
  });

  it('the per-order cap counts ATTEMPTS, connected or not (CALL_RELAY_MAX_ATTEMPTS_PER_ORDER)', async () => {
    const o = await liveFood();
    for (let i = 0; i < 3; i += 1) {
      const res = await bridge(diner.token, o.id, 'rider');
      expect(res.statusCode, `attempt ${i + 1}`).toBe(200);
      await hook('status', res.json().data.callId, { CallStatus: 'completed' }); // the route "answered", nobody pressed 1
    }
    const over = await bridge(diner.token, o.id, 'rider');
    expect([over.statusCode, over.json().error.code]).toEqual([429, 'CALL_LIMIT_REACHED']);
    expect(placed).toHaveLength(3);
  });

  it('a provider refusal records the attempt as FAILED and ended, says so, and frees the order', async () => {
    const o = await liveFood();
    twilioAnswers = 'refuse';
    const res = await bridge(diner.token, o.id, 'rider');
    expect([res.statusCode, res.json().error.code]).toEqual([502, 'CALL_PROVIDER_FAILED']);
    const rows = await system(() => app.prisma.callSession.findMany({ where: { orderId: o.id } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'FAILED' });
    expect(rows[0]!.endedAt).not.toBeNull();
    twilioAnswers = 'ok';
    expect((await bridge(diner.token, o.id, 'rider')).statusCode).toBe(200);
  });
});

describe('[O-1] the call itself: Press 1 on both legs', () => {
  it('the whole path: caller presses 1 -> Swift dials the other party from its own number, never recording, 30 min cap -> they press 1 -> connected', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;

    const leg1 = await hook('leg1', callId, { CallSid: `CA${'3'.repeat(32)}`, CallStatus: 'in-progress' });
    expect(leg1.statusCode).toBe(200);
    expect(leg1.body).toContain(`<Gather input="dtmf" numDigits="1" timeout="8" action="${BASE}/leg1-gather?s=${callId}" method="POST">`);
    expect(leg1.body).toContain(CALL_WORDS.callerPrompt);
    expect(leg1.body).not.toContain('<Dial');

    const gather = await hook('leg1-gather', callId, { Digits: '1' });
    expect(gather.body).toMatch(new RegExp(`<Dial callerId="\\${CALLER_ID}" timeout="25" timeLimit="1800" record="do-not-record" action="${BASE}/dial-done\\?s=${callId}" method="POST"><Number url="${BASE}/screen\\?s=${callId}" method="POST">\\${riderP.phone}</Number></Dial>`));
    expect((await session(callId))).toMatchObject({ status: 'CALLER_CONFIRMED' });
    const riderNotice = await callNotices(riderP.id);
    expect(riderNotice.at(-1)!.data).toMatchObject({ kind: 'call_incoming', callOrderId: o.id, from: 'customer', leg: 2, audience: 'earner' });
    expect(riderNotice.at(-1)!.body).toMatch(/Swift is calling you about your order .+: your customer\. Answer, then press 1 to connect\./);
    for (const p of allPhones()) expect(JSON.stringify(riderNotice.at(-1)).includes(p)).toBe(false);

    const screen = await hook('screen', callId, {});
    expect(screen.body).toContain(`action="${BASE}/screen-gather?s=${callId}"`);
    expect(screen.body).toContain('Swift call about your order. Press 1 to connect.');

    const connect = await hook('screen-gather', callId, { Digits: '1' });
    expect(connect.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const live = await session(callId);
    expect(live.status).toBe('CONNECTED');
    expect(live.connectedAt).not.toBeNull();

    await hook('dial-done', callId, { DialCallStatus: 'completed', DialCallDuration: '42' });
    const over = await session(callId);
    expect(over).toMatchObject({ status: 'CONNECTED', durationSeconds: 42 });
    expect(over.endedAt).not.toBeNull();
    // a late status callback changes nothing
    await hook('status', callId, { CallStatus: 'completed', CallDuration: '50' });
    expect((await session(callId)).durationSeconds).toBe(42);
  });

  it('the network "answers" leg 1 and nobody presses 1: no second leg, NOT_CONNECTED, nobody else is told', async () => {
    const o = await liveFood();
    const before = (await callNotices(riderP.id)).length;
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    await hook('leg1', callId, {});
    // Twilio's Gather posts nothing on silence; the call ends and the status callback says completed
    await hook('status', callId, { CallStatus: 'completed', CallDuration: '40' });
    const row = await session(callId);
    expect(row).toMatchObject({ status: 'NOT_CONNECTED', durationSeconds: 0 });
    expect(row.callerConfirmedAt).toBeNull();
    expect((await callNotices(riderP.id)).length).toBe(before);
    // a late gather after the end dials nothing
    expect((await hook('leg1-gather', callId, { Digits: '1' })).body).not.toContain('<Dial');
  });

  it('[REVIEW-M S4-3] a terminal status callback after the callee\'s 1 ends the call, never turns it NOT_CONNECTED', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    await hook('leg1-gather', callId, { Digits: '1' });
    await hook('screen-gather', callId, { Digits: '1' });
    await hook('status', callId, { CallStatus: 'completed', CallDuration: '61' });
    const row = await session(callId);
    expect(row.status).toBe('CONNECTED');
    expect(row.endedAt).not.toBeNull();
    expect(row.connectedAt).not.toBeNull();
  });

  // [REVIEW-G2 S4-1] The Dial is the one answer that carries the callee's number. A replayed or duplicate
  // 'caller pressed 1' (Twilio retries a webhook it did not see answered) must never dial a second time.
  it('a duplicate "caller pressed 1" never dials twice, in sequence or at the same moment', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    const first = await hook('leg1-gather', callId, { Digits: '1' });
    expect(first.body).toContain('<Dial');
    const again = await hook('leg1-gather', callId, { Digits: '1' });
    expect(again.body).not.toContain('<Dial');
    expect(again.body).not.toContain(riderP.phone);
    expect(again.body).toContain('<Hangup/>');
    await hook('dial-done', callId, { DialCallStatus: 'no-answer' });

    const o2 = await liveFood();
    const second = (await bridge(diner.token, o2.id, 'rider')).json().data.callId;
    const both = await Promise.all([hook('leg1-gather', second, { Digits: '1' }), hook('leg1-gather', second, { Digits: '1' })]);
    expect(both.filter((r) => r.body.includes('<Dial')).length).toBe(1);
    expect(both.filter((r) => r.body.includes(riderP.phone)).length).toBe(1);
    await hook('dial-done', second, { DialCallStatus: 'no-answer' });
  });

  // [REVIEW-G2 S4-2] The callee's "Press 1" prompt belongs to a call whose caller has confirmed, and to nothing else.
  it('the screen prompt is given only to a call whose caller pressed 1 and that is still going', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    const early = await hook('screen', callId, {});
    expect(early.body).not.toContain('<Gather');
    expect(early.body).toContain('<Hangup/>');
    await hook('leg1-gather', callId, { Digits: '1' });
    expect((await hook('screen', callId, {})).body).toContain('<Gather');
    await hook('dial-done', callId, { DialCallStatus: 'busy' });
    const late = await hook('screen', callId, {});
    expect(late.body).not.toContain('<Gather');
    expect(late.body).toContain('<Hangup/>');
    expect((await hook('screen-gather', callId, { Digits: '1' })).body).not.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('any key but 1 on leg 1 ends it without dialling', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    const out = await hook('leg1-gather', callId, { Digits: '2' });
    expect(out.body).not.toContain('<Dial');
    expect(out.body).toContain('<Hangup/>');
    expect((await session(callId)).status).toBe('NOT_CONNECTED');
  });

  it('the called phone does not press 1 (voicemail, an announcement): never connected, the caller hears so', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    await hook('leg1-gather', callId, { Digits: '1' });
    const refused = await hook('screen-gather', callId, { Digits: '9' });
    expect(refused.body).toContain('<Hangup/>');
    expect((await session(callId)).status).toBe('CALLER_CONFIRMED');
    const done = await hook('dial-done', callId, { DialCallStatus: 'completed', DialCallDuration: '12' });
    expect(done.body).toContain(CALL_WORDS.notReached);
    expect(await session(callId)).toMatchObject({ status: 'NOT_CONNECTED', durationSeconds: 0 });
  });

  it('the order finishes between the legs: nobody is dialled', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    await system(() => app.prisma.order.update({ where: { id: o.id }, data: { status: 'DELIVERED' } }));
    const out = await hook('leg1-gather', callId, { Digits: '1' });
    expect(out.body).not.toContain('<Dial');
    expect(out.body).toContain(CALL_WORDS.notReached);
    expect((await session(callId)).status).toBe('NOT_CONNECTED');
  });

  it('CALL_RELAY switched off mid-call: the next step hangs up', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    process.env['CALL_RELAY'] = '0';
    expect((await hook('leg1', callId, {})).body).not.toContain('<Gather');
    const g = await hook('leg1-gather', callId, { Digits: '1' });
    expect(g.body).not.toContain('<Dial');
    expect((await session(callId)).status).toBe('NOT_CONNECTED');
  });
});

describe('[O-1] the webhooks only answer Twilio', () => {
  it('unsigned, signed for another URL, or with another token: 403, nothing read or changed', async () => {
    const o = await liveFood();
    const { callId } = (await bridge(diner.token, o.id, 'rider')).json().data;
    expect((await hook('leg1-gather', callId, { Digits: '1' }, { sign: 'none' })).statusCode).toBe(403);
    expect((await hook('leg1-gather', callId, { Digits: '1' }, { sign: 'wrong-url' })).statusCode).toBe(403);
    process.env['TWILIO_WEBHOOK_AUTH_TOKEN'] = 'another-token';
    expect((await hook('leg1-gather', callId, { Digits: '1' })).statusCode).toBe(403);
    process.env['TWILIO_WEBHOOK_AUTH_TOKEN'] = TOKEN;
    expect((await session(callId)).status).toBe('DIALING_CALLER');
    await hook('status', callId, { CallStatus: 'canceled' });
  });

  it('unconfigured: 503; an unknown step: 404; an unknown call: hang up', async () => {
    delete process.env['CALL_RELAY_WEBHOOK_BASE'];
    expect((await hook('leg1', 'cxxxxxxxxxxxxxxxxxxxxxxxx', {})).statusCode).toBe(503);
    process.env['CALL_RELAY_WEBHOOK_BASE'] = BASE;
    expect((await hook('transfer', 'cxxxxxxxxxxxxxxxxxxxxxxxx', {})).statusCode).toBe(404);
    const unknown = await hook('leg1-gather', 'cxxxxxxxxxxxxxxxxxxxxxxxx', { Digits: '1' });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toContain('<Hangup/>');
    expect(unknown.body).not.toContain('<Dial');
  });

  it('a call back to Swift\'s number hears "call from the app" and is never forwarded', async () => {
    const fields = { From: [testPhone()], To: [CALLER_ID] };
    const url = `${BASE}/inbound`;
    const res = await app.inject({
      method: 'POST', url: '/api/v1/calls/voice/inbound',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, url, fields) },
      payload: new URLSearchParams({ From: fields.From[0]!, To: CALLER_ID }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(INBOUND_CALL_WORDS);
    expect(res.body).not.toContain('<Dial');
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/voice/inbound', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'From=x' })).statusCode).toBe(403);
  });
});
