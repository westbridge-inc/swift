/**
 * [INAPP-CALLS · owner 6 Nov 2026, "B"] In-app calling on the real routes and a real database.
 * The provider is the REAL Twilio adapter (signature checks + TwiML rendering) over a stubbed fetch:
 * nothing reaches a network. Every webhook is signed exactly as Twilio signs (full URL + form).
 *
 * Every party has a distinct number in the shape of a Guyana mobile line (gyPhone(), as the bridge's own suite:
 * [REVIEW-M17 S1-1] the dial guard refuses the fictional +5920 test block), never dialled (fetch is stubbed),
 * so a number anywhere it must not be (token, call screen line, row, response) is a leak.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, beginRequestTenantContext } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { callsRoutes, callVoiceRoutes, redisServiceDayLedger } from '../modules/calls/calls.routes';
import { CALL_DAY_PREFIX, SERVICE_DAY_KEY, type ServiceDayLedger } from '../modules/calls/call-bridge';
import { inAppCallsRoutes, inAppVoiceRoutes } from '../modules/calls/inapp-calls.routes';
import { inAppIdentity } from '../modules/calls/inapp-calls-switch';
import type { CallRelayConfig } from '../modules/calls/call-relay-switch';
import { TwilioVoiceProvider } from '../providers/voice/twilio-voice';
import { twilioSignature } from '../modules/notification/sms-inbound.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { testPhone } from './helpers/fixture-ids';

grantSuiteCapability('unscoped-mutation');

const TOKEN = 'inapp-test-webhook-token';
const SID = `AC${'4'.repeat(32)}`;
const KEY = `SK${'5'.repeat(32)}`;
const KEY_SECRET = 'inapp-test-key-secret';
const APP_SID = `AP${'6'.repeat(32)}`;
const CRED_IOS = `CR${'7'.repeat(32)}`;
const CRED_ANDROID = `CR${'8'.repeat(32)}`;
const IDENTITY_SECRET = 'inapp-test-identity-secret-0123456789abcdef';
const CALLER_ID = '+15005550006';
const BASE = 'https://api.example.test/api/v1/calls/voice';
const INAPP_ON = {
  INAPP_CALLS: '1', CALL_RELAY_WEBHOOK_BASE: BASE, CALL_RELAY_MAX_ATTEMPTS_PER_ORDER: '3',
  // [owner 6 Nov] The daily caps' own tests set them; every other test runs well under them. The call length is
  // the longest allowed (30) so the older documents keep their numbers; the default (10) has its own test.
  CALL_RELAY_MAX_CALLS_PER_DAY: '10000', CALL_RELAY_MAX_CALLS_PER_CUSTOMER_PER_DAY: '200', CALL_RELAY_MAX_CALLS_PER_PARTNER_PER_DAY: '200', CALL_RELAY_MAX_CALL_MINUTES: '30',
  INAPP_CALLS_TWIML_APP_SID: APP_SID, INAPP_CALLS_PUSH_CREDENTIAL_IOS: CRED_IOS, INAPP_CALLS_PUSH_CREDENTIAL_ANDROID: CRED_ANDROID,
  INAPP_CALLS_IDENTITY_SECRET: IDENTITY_SECRET,
  TWILIO_ACCOUNT_SID: SID, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: KEY_SECRET, TWILIO_WEBHOOK_AUTH_TOKEN: TOKEN,
};
const RELAY_ON = { CALL_RELAY: '1', CALL_RELAY_CALLER_ID: CALLER_ID };
const ALL_KEYS = [...Object.keys(INAPP_ON), ...Object.keys(RELAY_ON)];
const NUM = String(Date.now()).slice(-5);
/** [REVIEW-M17 S1-1] A complete Guyana mobile number in shape, distinct within the run (fetch is stubbed: never dialled). */
let gySeq = Math.floor(Math.random() * 9000);
const gyPhone = () => `+592698${String((gySeq++ % 9000) + 1000)}`;
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'inapp-calls-test');
const http = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;

let app: FastifyInstance;
/** [REVIEW-M17 S2-1] The real service day list, except that it fails on demand (the faulty door below). */
let ledgerFault: 'none' | 'count-throws' | 'add-throws' = 'none';
const realLedger = () => redisServiceDayLedger(app.redis);
const faultyLedger: ServiceDayLedger = {
  count: async (since) => { if (ledgerFault === 'count-throws') throw new Error('redis down'); return realLedger().count(since); },
  add: async (member, at) => { if (ledgerFault === 'add-throws') throw new Error('redis down'); return realLedger().add(member, at); },
  remove: async (member) => realLedger().remove(member),
};
const users: string[] = [];
const orderIds: string[] = [];
const tenantIds: string[] = [];

type Person = { id: string; token: string; phone: string; sessionId: string; deviceId: string };
async function person(n: number, roles: string[], active: string, extra: Record<string, unknown> = {}, phone = gyPhone()): Promise<Person> {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone, firstName: 'Inapp', lastName: `Party${n}`, roles: roles as never, activeRole: active as never,
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId: 'swift-default', ...extra,
  } as never }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: active, jti: nanoid(8) });
  const deviceId = `inapp-${n}-${NUM}`;
  const s = await system(() => app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: u.id, token, phone, sessionId: s.id, deviceId };
}

const money = { subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, tipAmount: 0, totalAmount: 3500, paymentMethod: 'CASH' };
async function order(data: Record<string, unknown>) {
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `CIA${NUM}${nanoid(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
    pickupAddress: 'Inapp Pickup', pickupLat: 6.8021, pickupLng: -58.1561,
    deliveryAddress: '1 Inapp St', deliveryLat: 6.8121, deliveryLng: -58.1461,
    ...money, ...data,
  } as never }));
  orderIds.push(o.id);
  return o;
}

let diner: Person, riderP: Person, sender: Person, courierP: Person, owner: Person, staff: Person, passenger: Person, driverP: Person, stranger: Person;
let riderId = '', courierRiderId = '', driverId = '', vendorId = '';
const STORE_LINE = gyPhone();
const RECIPIENT = gyPhone();
const allPhones = () => [diner, riderP, sender, courierP, owner, staff, passenger, driverP, stranger].map((p) => p.phone).concat(STORE_LINE, RECIPIENT);
/** The identity of a person's ONE current session (per user + session + device; rotates on sign-out). */
const id = (p: Pick<Person, 'id' | 'sessionId' | 'deviceId'>) => inAppIdentity(IDENTITY_SECRET, p.id, p.sessionId, p.deviceId);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  // As app.ts does: a fresh tenant store per request, so auth binds the person's own operator (the tenant wall).
  app.addHook('onRequest', (_req, _reply, done) => { beginRequestTenantContext(); done(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  const provider = (twilio: ConstructorParameters<typeof TwilioVoiceProvider>[0]) => new TwilioVoiceProvider(twilio, http);
  await app.register(callsRoutes, { prefix: '/api/v1/calls', provider: (c: CallRelayConfig) => provider(c.twilio) });
  await app.register(callVoiceRoutes, { prefix: '/api/v1/calls/voice', provider: (c: CallRelayConfig) => provider(c.twilio) });
  await app.register(inAppCallsRoutes, { prefix: '/api/v1/calls/app', provider });
  await app.register(inAppCallsRoutes, { prefix: '/api/v1/calls/app-faulty', provider, ledger: faultyLedger });
  await app.register(inAppVoiceRoutes, { prefix: '/api/v1/calls/voice', provider });
  await app.ready();
  for (const key of await app.redis.keys(`${CALL_DAY_PREFIX}*`)) await app.redis.del(key);

  diner = await person(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  sender = await person(2, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  passenger = await person(3, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  riderP = await person(4, ['RIDER', 'CUSTOMER'], 'RIDER');
  courierP = await person(5, ['RIDER', 'CUSTOMER'], 'RIDER');
  driverP = await person(6, ['MOVER', 'CUSTOMER'], 'MOVER');
  owner = await person(7, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  staff = await person(8, ['CUSTOMER'], 'CUSTOMER');
  stranger = await person(9, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });

  riderId = (await system(() => app.prisma.rider.create({ data: { userId: riderP.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
  courierRiderId = (await system(() => app.prisma.rider.create({ data: { userId: courierP.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
  driverId = (await system(() => app.prisma.driver.create({ data: {
    userId: driverP.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver',
    licensePlate: `PIA ${NUM}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } }))).id;
  const vo = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: owner.id, vendors: { create: {
    name: `Inapp Diner ${NUM}`, slug: `inapp-diner-${NUM}-${nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, vendorType: 'RESTAURANT',
    phone: STORE_LINE, addressLine1: '2 Inapp St', city: 'Georgetown', region: 'Demerara-Mahaica',
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
    if (tenantIds.length) await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  });
  for (const key of await app.redis.keys(`${CALL_DAY_PREFIX}*`)) await app.redis.del(key);
  await app.close();
});

const saved: Record<string, string | undefined> = {};
function setEnv(env: Record<string, string>) {
  for (const k of ALL_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}
beforeEach(async () => {
  for (const k of ALL_KEYS) saved[k] = process.env[k];
  setEnv(INAPP_ON);
  // [owner 6 Nov] One live call per PERSON across orders: every test starts with this suite's calls over, as
  // real calls end (Twilio's status callback), so one test's ringing row never makes the next test's caller busy.
  if (users.length) {
    await system(() => app.prisma.callSession.updateMany({ where: { callerUserId: { in: users }, endedAt: null }, data: { endedAt: new Date(), status: 'NOT_CONNECTED' } }));
  }
});
afterEach(() => {
  for (const k of ALL_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const start = (token: string, orderId: string, target: string, platform = 'ios') =>
  app.inject({ method: 'POST', url: '/api/v1/calls/app', headers: auth(token), payload: { orderId, target, platform } });
const regToken = (token: string, platform = 'android') =>
  app.inject({ method: 'POST', url: '/api/v1/calls/app/token', headers: auth(token), payload: { platform } });

/** Post a webhook exactly as Twilio would: form body, signature over the public URL + form. */
function hook(step: string, form: Record<string, string> = {}, opts: { s?: string; sign?: 'ok' | 'none' | 'wrong-url' } = {}) {
  const fields = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, [v]]));
  const query = opts.s !== undefined ? `?s=${encodeURIComponent(opts.s)}` : '';
  const signedUrl = opts.sign === 'wrong-url' ? `${BASE}/${step}?s=someone-else` : `${BASE}/${step}${query}`;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.sign !== 'none') headers['x-twilio-signature'] = twilioSignature(TOKEN, signedUrl, fields);
  return app.inject({ method: 'POST', url: `/api/v1/calls/voice/${step}${query}`, headers, payload: new URLSearchParams(form).toString() });
}
const sid = () => `CA${crypto.randomBytes(16).toString('hex')}`;
/** The caller's phone connecting to the TwiML App with its call id (what voice.connect sends). */
const connect = (callId: string, caller: Person, callSid = sid()) =>
  hook('app', { CallSid: callSid, From: `client:${id(caller)}`, To: '', callId }).then((r) => ({ r, callSid }));

const session = (callId: string) => system(() => app.prisma.callSession.findUniqueOrThrow({ where: { id: callId } }));
const rowsFor = (orderId: string) => system(() => app.prisma.callSession.findMany({ where: { orderId } }));
const liveFood = () => order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: diner.id, vendorId, riderId, status: 'PICKED_UP', acceptedAt: new Date() });

function jwtParts(token: string) {
  const [h, p, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString()),
    signatureOk: crypto.createHmac('sha256', KEY_SECRET).update(`${h}.${p}`).digest('base64url') === s,
  };
}

describe('[INAPP-CALLS] switch off (how build 13 ships): nothing is issued, written or rung', () => {
  it('config says off; token, start and cancel refuse with INAPP_CALLS_OFF and write no row', async () => {
    setEnv({ ...INAPP_ON, INAPP_CALLS: '0' });
    const o = await liveFood();
    const cfg = await app.inject({ method: 'GET', url: '/api/v1/calls/app/config', headers: auth(diner.token) });
    expect(cfg.json().data).toEqual({ enabled: false });
    for (const res of [await regToken(diner.token), await start(diner.token, o.id, 'rider'),
      await app.inject({ method: 'POST', url: '/api/v1/calls/app/cabcdefghijklmnopqrstuvwx/cancel', headers: auth(diner.token) })]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INAPP_CALLS_OFF');
    }
    expect(await rowsFor(o.id)).toHaveLength(0);
  });

  it('signed-out: 401 on every door', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/calls/app/config' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/app/token', payload: { platform: 'ios' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/app', payload: { orderId: 'x', target: 'rider', platform: 'ios' } })).statusCode).toBe(401);
  });

  it('a ringing call when the switch goes off is hung up, never rung on', async () => {
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    setEnv({ ...INAPP_ON, INAPP_CALLS: '0' });
    const { r } = await connect(callId, diner);
    expect(r.body).toContain('<Hangup/>');
    expect(r.body).not.toContain('<Dial');
  });
});

describe('[INAPP-CALLS] tokens: only the people on a live order, opaque identity, never a number', () => {
  it('a party gets a short token for its platform: identity grant + VoiceGrant (TwiML App, push credential, incoming)', async () => {
    await liveFood();
    const now = Math.floor(Date.now() / 1000);
    const res = await regToken(riderP.token, 'android');
    expect(res.statusCode).toBe(200);
    const { token, identity, ttlSeconds } = res.json().data;
    expect(identity).toBe(id(riderP));
    expect(identity).toMatch(/^s[0-9a-f]{40}$/);
    expect(identity).not.toContain(riderP.id);
    const { header, payload, signatureOk } = jwtParts(token);
    expect(signatureOk).toBe(true);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
    expect(payload).toMatchObject({ iss: KEY, sub: SID, grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: APP_SID }, push_credential_sid: CRED_ANDROID } } });
    expect(payload.jti).toMatch(new RegExp(`^${KEY}-\\d+$`));
    expect(payload.exp - payload.iat).toBe(ttlSeconds);
    expect(ttlSeconds).toBe(900);
    expect(Math.abs(payload.iat - now)).toBeLessThan(5);
    // iPhone gets the iPhone credential
    expect(jwtParts((await regToken(diner.token, 'ios')).json().data.token).payload.grants.voice.push_credential_sid).toBe(CRED_IOS);
    for (const p of allPhones()) expect(res.body.includes(p) || JSON.stringify(payload).includes(p)).toBe(false);
  });

  it('store owner and staff of a live store order get one; a stranger and a party to only finished orders do not', async () => {
    await liveFood();
    expect((await regToken(owner.token)).statusCode).toBe(200);
    expect((await regToken(staff.token)).statusCode).toBe(200);
    const s = await regToken(stranger.token);
    expect(s.statusCode).toBe(403);
    expect(s.json().error.code).toBe('INAPP_NO_LIVE_ORDER');
    await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: sender.id, vendorId, status: 'DELIVERED', acceptedAt: new Date() });
    expect((await regToken(sender.token)).statusCode).toBe(403);
  });

  it('a malformed platform is refused', async () => {
    await liveFood();
    expect((await regToken(diner.token, 'web')).statusCode).toBe(400);
  });
});

describe('[INAPP-CALLS] starting a call: the bridge\'s party rules, one budget with the bridge', () => {
  it('the customer calls the rider: a row with no number, provider twilio-app, RINGING_APP; a token to connect', async () => {
    const o = await liveFood();
    const res = await start(diner.token, o.id, 'rider', 'ios');
    expect(res.statusCode).toBe(200);
    const { callId, token } = res.json().data;
    expect(jwtParts(token).payload.grants.identity).toBe(id(diner));
    const row = await session(callId);
    expect(row).toMatchObject({ provider: 'twilio-app', status: 'RINGING_APP', callerUserId: diner.id, callerRole: 'customer', calleeRole: 'rider', providerCallId: null });
    for (const p of allPhones()) expect(JSON.stringify(row).includes(p) || res.body.includes(p)).toBe(false);
  });

  it('not a party is answered exactly like no order (404, no row)', async () => {
    const o = await liveFood();
    for (const res of [await start(stranger.token, o.id, 'rider'), await start(stranger.token, 'no-such-order', 'rider')]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect(await rowsFor(o.id)).toHaveLength(0);
  });

  it('a finished order, a pair the order cannot have, and the parcel recipient are refused before any row', async () => {
    const done = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: diner.id, vendorId, riderId, status: 'DELIVERED', acceptedAt: new Date() });
    expect((await start(diner.token, done.id, 'rider')).json().error.code).toBe('CALL_ORDER_NOT_LIVE');
    const o = await liveFood();
    expect((await start(diner.token, o.id, 'driver')).json().error.code).toBe('CALL_TARGET_INVALID');
    expect((await start(diner.token, o.id, 'customer')).json().error.code).toBe('CALL_TARGET_INVALID');
    const parcel = await order({ orderType: 'COURIER', customerId: sender.id, riderId: courierRiderId, status: 'PICKED_UP', courierRecipientPhone: RECIPIENT, acceptedAt: new Date() });
    const r = await start(courierP.token, parcel.id, 'recipient');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INAPP_NOT_FOR_TARGET');
    expect([...await rowsFor(done.id), ...await rowsFor(o.id), ...await rowsFor(parcel.id)]).toHaveLength(0);
  });

  it('one live call per order, and the per-order cap counts in-app and bridge attempts together', async () => {
    const o = await liveFood();
    const firstCall = (await start(diner.token, o.id, 'rider')).json().data.callId;
    const busy = await start(riderP.token, o.id, 'customer');
    expect(busy.json().error.code).toBe('CALL_IN_PROGRESS');
    // the caller's phone could not connect: cancel frees the order at once
    expect((await app.inject({ method: 'POST', url: `/api/v1/calls/app/${firstCall}/cancel`, headers: auth(diner.token) })).statusCode).toBe(200);
    const second = (await start(riderP.token, o.id, 'customer')).json().data.callId;
    await app.inject({ method: 'POST', url: `/api/v1/calls/app/${second}/cancel`, headers: auth(riderP.token) });
    // a bridge attempt in between (CALL_RELAY on) spends the same budget
    setEnv({ ...INAPP_ON, ...RELAY_ON });
    const bridged = await app.inject({ method: 'POST', url: '/api/v1/calls/bridge', headers: auth(diner.token), payload: { orderId: o.id, target: 'rider' } });
    expect(bridged.statusCode).toBe(502); // the stubbed provider refuses; the attempt is still counted and ended
    const capped = await start(diner.token, o.id, 'rider');
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('CALL_LIMIT_REACHED');
    expect(await rowsFor(o.id)).toHaveLength(3);
  });

  it('only the caller can cancel, and only a call Twilio never took', async () => {
    const o = await liveFood();
    const callId = (await start(diner.token, o.id, 'rider')).json().data.callId;
    expect((await app.inject({ method: 'POST', url: `/api/v1/calls/app/${callId}/cancel`, headers: auth(riderP.token) })).statusCode).toBe(404);
    await connect(callId, diner);
    expect((await app.inject({ method: 'POST', url: `/api/v1/calls/app/${callId}/cancel`, headers: auth(diner.token) })).statusCode).toBe(404);
    expect((await session(callId)).endedAt).toBeNull();
  });

  it('a start Twilio never took stops holding the order after a minute', async () => {
    const o = await liveFood();
    const callId = (await start(diner.token, o.id, 'rider')).json().data.callId;
    await system(() => app.prisma.callSession.update({ where: { id: callId }, data: { createdAt: new Date(Date.now() - 61_000) } }));
    expect((await start(diner.token, o.id, 'rider')).statusCode).toBe(200);
    expect(await session(callId)).toMatchObject({ status: 'NOT_CONNECTED', durationSeconds: 0 });
  });
});

describe('[INAPP-CALLS] the tenant wall: another operator\'s person never reaches this operator\'s order', () => {
  it('a person of tenant B named as the customer of a swift-default order gets 404 / no token, and no row', async () => {
    const tenantId = `inapp-tenant-b-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    // A second live operator. It is removed at the end of THIS test (finally below): while it exists the public
    // operator is ambiguous for every suite sharing the database (platform promo codes and the public market refuse).
    await system(() => app.prisma.tenant.create({ data: { id: tenantId, name: 'Inapp tenant B', slug: tenantId, isActive: true, kind: 'PRODUCTION' } }));
    tenantIds.push(tenantId);
    try {
      const phone = testPhone();
      const u = await system(() => app.prisma.user.create({ data: {
        phone, firstName: 'Inapp', lastName: 'TenantB', roles: ['CUSTOMER'] as never, activeRole: 'CUSTOMER' as never,
        countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, tenantId,
      } as never }));
      users.push(u.id);
      const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
      await system(() => app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `inapp-b-${NUM}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
      const o = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: u.id, vendorId, riderId, status: 'PICKED_UP', acceptedAt: new Date() });
      const res = await start(token, o.id, 'rider');
      expect(res.statusCode, res.body).toBe(404);
      expect((await regToken(token)).statusCode).toBe(403);
      expect(await rowsFor(o.id)).toHaveLength(0);
    } finally {
      await system(async () => {
        const theirs = await app.prisma.user.findMany({ where: { tenantId }, select: { id: true } });
        const ids = theirs.map((t) => t.id);
        const orders = await app.prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
        await app.prisma.callSession.deleteMany({ where: { orderId: { in: orders.map((x) => x.id) } } });
        await app.prisma.order.deleteMany({ where: { id: { in: orders.map((x) => x.id) } } });
        await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
        await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
        await app.prisma.tenant.delete({ where: { id: tenantId } });
      });
    }
  });
});

describe('[INAPP-CALLS] the call: Swift rings the other app with role words, never a number', () => {
  it('the whole path: connect -> the rider\'s app rings with "Swift: your customer is calling about your order" -> answered -> ended', async () => {
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    const { r, callSid } = await connect(callId, diner);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`<Dial callerId="client:Swift" timeout="20" timeLimit="1800" record="do-not-record" action="${BASE}/app-dial-done?s=${callId}" method="POST">`);
    expect(r.body).toContain(`<Client url="${BASE}/app-answered?s=${callId}" method="POST"><Identity>${id(riderP)}</Identity>`);
    expect(r.body).toContain('<Parameter name="swiftLine" value="Swift: your customer is calling about your order"/>');
    for (const p of allPhones()) expect(r.body.includes(p)).toBe(false);
    expect(r.body).not.toContain(riderP.id);
    expect((await session(callId)).providerCallId).toBe(callSid);

    const answered = await hook('app-answered', { CallSid: sid() }, { s: callId });
    expect(answered.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect((await session(callId)).status).toBe('CONNECTED');

    await hook('app-dial-done', { DialCallStatus: 'completed', DialCallDuration: '73' }, { s: callId });
    const over = await session(callId);
    expect(over).toMatchObject({ status: 'CONNECTED', durationSeconds: 73 });
    expect(over.endedAt).not.toBeNull();
    // a late status callback for the caller's leg changes nothing
    await hook('app-status', { CallSid: callSid, CallStatus: 'completed' });
    expect((await session(callId)).durationSeconds).toBe(73);
  });

  it('the rider calls a store: the owner and the staff seat ring together; the line says "the store" side correctly', async () => {
    const o = await liveFood();
    const { callId } = (await start(riderP.token, o.id, 'store')).json().data;
    const { r } = await connect(callId, riderP);
    expect(r.body).toContain(`<Identity>${id(owner)}</Identity>`);
    expect(r.body).toContain(`<Identity>${id(staff)}</Identity>`);
    expect(r.body).toContain('value="Swift: your rider is calling about your order"');
  });

  it('a taxi: the passenger calls the driver ("your passenger" on the driver\'s screen)', async () => {
    const t = await order({ orderType: 'TAXI', customerId: passenger.id, driverId, status: 'DRIVER_EN_ROUTE', ridePin: '123456' });
    const { callId } = (await start(passenger.token, t.id, 'driver')).json().data;
    const { r } = await connect(callId, passenger);
    expect(r.body).toContain(`<Identity>${id(driverP)}</Identity>`);
    expect(r.body).toContain('value="Swift: your passenger is calling about your order"');
  });

  it('only THIS call\'s caller can connect it, once: another identity, a replay and an unknown id are hung up', async () => {
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    const impostor = await hook('app', { CallSid: sid(), From: `client:${id(stranger)}`, callId });
    expect(impostor.body).not.toContain('<Dial');
    const asRider = await hook('app', { CallSid: sid(), From: `client:${id(riderP)}`, callId });
    expect(asRider.body).not.toContain('<Dial');
    expect((await session(callId)).providerCallId).toBeNull();
    const ok = await connect(callId, diner);
    expect(ok.r.body).toContain('<Dial');
    const replay = await connect(callId, diner);
    expect(replay.r.body).not.toContain('<Dial');
    expect((await session(callId)).providerCallId).toBe(ok.callSid);
    expect((await hook('app', { CallSid: sid(), From: `client:${id(diner)}`, callId: 'cnosuchcallnosuchcallxx' })).body).toContain('<Hangup/>');
  });

  it('unsigned, wrongly signed, and signed-for-another-URL webhooks are refused (403) and change nothing', async () => {
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    const form = { CallSid: sid(), From: `client:${id(diner)}`, callId };
    expect((await hook('app', form, { sign: 'none' })).statusCode).toBe(403);
    const fields = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, [v]]));
    const forged = await app.inject({ method: 'POST', url: '/api/v1/calls/voice/app', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('not-the-token', `${BASE}/app`, fields) }, payload: new URLSearchParams(form).toString() });
    expect(forged.statusCode).toBe(403);
    expect((await hook('app-answered', {}, { s: callId, sign: 'wrong-url' })).statusCode).toBe(403);
    expect(await session(callId)).toMatchObject({ status: 'RINGING_APP', providerCallId: null });
  });

  it('unconfigured: every in-app webhook answers 503', async () => {
    setEnv({});
    expect((await hook('app', { callId: 'x' })).statusCode).toBe(503);
    expect((await hook('app-status', {})).statusCode).toBe(503);
  });

  it('the order finished before the app rang: nobody is rung, NOT_CONNECTED', async () => {
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    await system(() => app.prisma.order.update({ where: { id: o.id }, data: { status: 'DELIVERED' } }));
    const { r } = await connect(callId, diner);
    expect(r.body).not.toContain('<Dial');
    expect((await session(callId)).status).toBe('NOT_CONNECTED');
  });

  it('caller hangs up while it rings: the status callback ends the row NOT_CONNECTED', async () => {
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    const { callSid } = await connect(callId, diner);
    await hook('app-status', { CallSid: callSid, CallStatus: 'canceled' });
    const row = await session(callId);
    expect(row).toMatchObject({ status: 'NOT_CONNECTED', durationSeconds: 0 });
    expect(row.endedAt).not.toBeNull();
  });
});

describe('[INAPP-CALLS] not answered in the app: the phone bridge in the same call (CALL_RELAY on)', () => {
  it('no answer -> Swift rings their PHONE from Swift\'s number with the bridge\'s Press 1, and they are told by push', async () => {
    setEnv({ ...INAPP_ON, ...RELAY_ON });
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    await connect(callId, diner);
    const done = await hook('app-dial-done', { DialCallStatus: 'no-answer' }, { s: callId });
    expect(done.body).toContain('They are not answering in the app. Swift is calling their phone now.');
    expect(done.body).toMatch(new RegExp(`<Dial callerId="\\${CALLER_ID}" timeout="25" timeLimit="1800" record="do-not-record" action="${BASE}/dial-done\\?s=${callId}" method="POST"><Number url="${BASE}/screen\\?s=${callId}" method="POST">\\${riderP.phone}</Number></Dial>`));
    expect(await session(callId)).toMatchObject({ status: 'CALLER_CONFIRMED' });
    const notices = await system(() => app.prisma.notification.findMany({ where: { userId: riderP.id }, orderBy: { createdAt: 'asc' } }));
    expect(notices.at(-1)!.data).toMatchObject({ kind: 'call_incoming', callOrderId: o.id, leg: 2 });
    // the bridge's own steps finish it
    expect((await hook('screen', {}, { s: callId })).body).toContain('Press 1 to connect.');
    expect((await hook('screen-gather', { Digits: '1' }, { s: callId })).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    await hook('dial-done', { DialCallStatus: 'completed', DialCallDuration: '30' }, { s: callId });
    expect(await session(callId)).toMatchObject({ status: 'CONNECTED', durationSeconds: 30 });
  });

  it('declined in the app (busy): no phone call after it, "couldn\'t reach them", NOT_CONNECTED', async () => {
    setEnv({ ...INAPP_ON, ...RELAY_ON });
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    await connect(callId, diner);
    const done = await hook('app-dial-done', { DialCallStatus: 'busy' }, { s: callId });
    expect(done.body).not.toContain('<Dial');
    expect(done.body).toContain("We couldn't reach them.");
    expect((await session(callId)).status).toBe('NOT_CONNECTED');
  });

  it('CALL_RELAY off: no phone fallback, just "couldn\'t reach them"', async () => {
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    await connect(callId, diner);
    const done = await hook('app-dial-done', { DialCallStatus: 'no-answer' }, { s: callId });
    expect(done.body).not.toContain('<Dial');
    for (const p of allPhones()) expect(done.body.includes(p)).toBe(false);
    expect((await session(callId)).status).toBe('NOT_CONNECTED');
  });

  it('a duplicate dial-done never rings the phone twice', async () => {
    setEnv({ ...INAPP_ON, ...RELAY_ON });
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    await connect(callId, diner);
    expect((await hook('app-dial-done', { DialCallStatus: 'no-answer' }, { s: callId })).body).toContain('<Number');
    expect((await hook('app-dial-done', { DialCallStatus: 'no-answer' }, { s: callId })).body).not.toContain('<Number');
  });
});

// [SECURITY REVIEW, MEDIUM] The identity is per signed-in phone (user + session + device) and rotates on sign-out.
// A phone that stays registered under an old identity can never be rung, and a token only ever names the
// session asking for it.
describe('[INAPP-CALLS] identity per session: a signed-out phone is never rung, a token names only its own session', () => {
  async function secondSession(p: Person, tag: string): Promise<Person> {
    const token = app.jwt.sign({ userId: p.id, role: 'RIDER', jti: nanoid(8) });
    const deviceId = `inapp-${tag}-${NUM}`;
    const s = await system(() => app.prisma.session.create({ data: { userId: p.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
    return { ...p, token, sessionId: s.id, deviceId };
  }
  const signOut = (p: Person) => system(() => app.prisma.session.delete({ where: { id: p.sessionId } }));

  it('each phone (session) has its own identity, and a token names only the session that asked', async () => {
    await liveFood();
    const phone2 = await secondSession(riderP, 'rider-phone2');
    expect(id(phone2)).not.toBe(id(riderP));
    expect((await regToken(riderP.token)).json().data.identity).toBe(id(riderP));
    expect((await regToken(phone2.token)).json().data.identity).toBe(id(phone2));
    await signOut(phone2);
  });

  it('both of the rider\'s signed-in phones ring; after one signs out, only the other', async () => {
    const phone2 = await secondSession(riderP, 'rider-phone3');
    const o1 = await liveFood();
    const first = (await start(diner.token, o1.id, 'rider')).json().data.callId;
    const { r: ringing1, callSid: sid1 } = await connect(first, diner);
    const ring1 = ringing1.body;
    expect(ring1).toContain(`<Identity>${id(riderP)}</Identity>`);
    expect(ring1).toContain(`<Identity>${id(phone2)}</Identity>`);
    // the first call ends (one live call per person) before the second
    await hook('app-status', { CallSid: sid1, CallStatus: 'completed' });
    await signOut(phone2);
    const o2 = await liveFood();
    const second = (await start(diner.token, o2.id, 'rider')).json().data.callId;
    const ring2 = (await connect(second, diner)).r.body;
    expect(ring2).toContain(`<Identity>${id(riderP)}</Identity>`);
    expect(ring2).not.toContain(id(phone2));
  });

  it('a caller whose phone signed out after starting cannot connect with the old identity', async () => {
    const phone2 = await secondSession(diner, 'diner-phone2');
    const o = await liveFood();
    const { callId } = (await start(phone2.token, o.id, 'rider')).json().data;
    await signOut(phone2);
    const { r } = await connect(callId, phone2);
    expect(r.body).not.toContain('<Dial');
    expect((await session(callId)).providerCallId).toBeNull();
  });

  it('unregister: any signed-in session gets a token for ITSELF without a live order; register still needs one', async () => {
    const reg = await regToken(stranger.token);
    expect(reg.statusCode).toBe(403);
    const un = await app.inject({ method: 'POST', url: '/api/v1/calls/app/token', headers: auth(stranger.token), payload: { platform: 'ios', purpose: 'unregister' } });
    expect(un.statusCode).toBe(200);
    expect(un.json().data.identity).toBe(id(stranger));
    expect(jwtParts(un.json().data.token).payload.grants.identity).toBe(id(stranger));
    const bad = await app.inject({ method: 'POST', url: '/api/v1/calls/app/token', headers: auth(stranger.token), payload: { platform: 'ios', purpose: 'someone-else' } });
    expect(bad.statusCode).toBe(400);
  });

  it('nobody signed in for them in the app and the bridge on: straight to their phone, never a silent ring', async () => {
    setEnv({ ...INAPP_ON, ...RELAY_ON });
    const parked = await system(() => app.prisma.session.findMany({ where: { userId: riderP.id } }));
    await system(() => app.prisma.session.updateMany({ where: { userId: riderP.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    try {
      const o = await liveFood();
      const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
      const { r } = await connect(callId, diner);
      expect(r.body).not.toContain('<Client');
      expect(r.body).toContain(`<Number url="${BASE}/screen?s=${callId}" method="POST">`);
      expect((await session(callId)).status).toBe('CALLER_CONFIRMED');
    } finally {
      for (const p of parked) await system(() => app.prisma.session.update({ where: { id: p.id }, data: { expiresAt: p.expiresAt } }));
    }
  });
});

// [owner 6 Nov · #2379] The bridge's daily rules hold for in-app calls too, over the same rows and the same service
// list: one budget for every Swift call (an in-app call can fall back to a paid phone leg).
describe('[INAPP-CALLS] the bridge\'s daily rules: one live call per person, the person\'s day, the service\'s day', () => {
  const pastRow = (callerUserId: string, callerRole: string, orderId: string, status = 'NOT_CONNECTED') => system(() => app.prisma.callSession.create({
    data: { orderId, callerUserId, callerRole, calleeRole: callerRole === 'customer' ? 'rider' : 'customer', provider: 'twilio', status, endedAt: new Date(), tenantId: 'swift-default' } as never,
  }));

  it('one live call per person: a ringing in-app call on one order refuses a start on another (409 CALL_CALLER_BUSY)', async () => {
    const o1 = await liveFood();
    const o2 = await liveFood();
    expect((await start(diner.token, o1.id, 'rider')).statusCode).toBe(200);
    const busy = await start(diner.token, o2.id, 'rider');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('CALL_CALLER_BUSY');
    expect(await rowsFor(o2.id)).toHaveLength(0);
  });

  it('the person\'s day counts bridged and in-app calls together, by their role on the order; FAILED starts do not count', async () => {
    setEnv({ ...INAPP_ON, CALL_RELAY_MAX_CALLS_PER_CUSTOMER_PER_DAY: '2', CALL_RELAY_MAX_CALLS_PER_PARTNER_PER_DAY: '200' });
    const used = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: sender.id, vendorId, riderId, status: 'DELIVERED', acceptedAt: new Date() });
    const before = await system(() => app.prisma.callSession.count({ where: { callerUserId: sender.id, callerRole: 'customer', status: { not: 'FAILED' }, createdAt: { gte: new Date(Date.now() - DAY) } } }));
    expect(before).toBe(0);
    await pastRow(sender.id, 'customer', used.id);              // a bridged call earlier today
    await pastRow(sender.id, 'customer', used.id, 'FAILED');    // nothing dialled: no slot
    const o = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: sender.id, vendorId, riderId, status: 'PICKED_UP', acceptedAt: new Date() });
    const second = await start(sender.token, o.id, 'rider');
    expect(second.statusCode, second.body).toBe(200);
    await app.inject({ method: 'POST', url: `/api/v1/calls/app/${second.json().data.callId}/cancel`, headers: auth(sender.token) });
    const third = await start(sender.token, o.id, 'rider');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('CALL_USER_DAILY_LIMIT_REACHED');
    // the rider on the same order is a partner: their own day, not the customer's
    expect((await start(riderP.token, o.id, 'customer')).statusCode).toBe(200);
  });

  it('the service\'s day: at the shared cap the start is refused (429 CALL_DAILY_LIMIT_REACHED) and nothing is written', async () => {
    const o = await liveFood();
    await pastRow(diner.id, 'customer', o.id);
    const today = await system(() => app.prisma.callSession.count({ where: { status: { not: 'FAILED' }, createdAt: { gte: new Date(Date.now() - DAY) } } }));
    setEnv({ ...INAPP_ON, CALL_RELAY_MAX_CALLS_PER_DAY: String(today) });
    const rowsBefore = (await rowsFor(o.id)).length;
    const res = await start(diner.token, o.id, 'rider');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CALL_DAILY_LIMIT_REACHED');
    expect(await rowsFor(o.id)).toHaveLength(rowsBefore);
  });

  it('every start is written to the bridge\'s service list (call id and time only); the list going down refuses the start (503), no row', async () => {
    const o = await liveFood();
    const ok = await start(diner.token, o.id, 'rider');
    expect(ok.statusCode).toBe(200);
    expect(await app.redis.zscore(SERVICE_DAY_KEY, ok.json().data.callId)).not.toBeNull();
    await app.inject({ method: 'POST', url: `/api/v1/calls/app/${ok.json().data.callId}/cancel`, headers: auth(diner.token) });
    for (const fault of ['count-throws', 'add-throws'] as const) {
      const o2 = await liveFood();
      ledgerFault = fault;
      try {
        const res = await app.inject({ method: 'POST', url: '/api/v1/calls/app-faulty', headers: auth(diner.token), payload: { orderId: o2.id, target: 'rider', platform: 'ios' } });
        expect(res.statusCode, fault).toBe(503);
        expect(res.json().error.code).toBe('CALL_PROVIDER_FAILED');
        expect(await rowsFor(o2.id), fault).toHaveLength(0);
      } finally { ledgerFault = 'none'; }
    }
  });

  it('the call length is the owner\'s 10 minutes by default, on the app leg and the phone fallback leg', async () => {
    const env: Record<string, string> = { ...INAPP_ON, ...RELAY_ON };
    delete env['CALL_RELAY_MAX_CALL_MINUTES'];
    setEnv(env);
    const o = await liveFood();
    const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
    const { r } = await connect(callId, diner);
    expect(r.body).toContain('<Dial callerId="client:Swift" timeout="20" timeLimit="600"');
    const done = await hook('app-dial-done', { DialCallStatus: 'no-answer' }, { s: callId });
    expect(done.body).toMatch(new RegExp(`<Dial callerId="\\${CALLER_ID}" timeout="25" timeLimit="600"`));
  });

  it('the phone fallback rings only a number the bridge\'s dial guard accepts: an off-plan number is never dialled', async () => {
    setEnv({ ...INAPP_ON, ...RELAY_ON });
    const offPlan = await person(10, ['RIDER', 'CUSTOMER'], 'RIDER', {}, testPhone());
    const offPlanRider = (await system(() => app.prisma.rider.create({ data: { userId: offPlan.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
    try {
      const o = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: diner.id, vendorId, riderId: offPlanRider, status: 'PICKED_UP', acceptedAt: new Date() });
      const { callId } = (await start(diner.token, o.id, 'rider')).json().data;
      await connect(callId, diner);
      const done = await hook('app-dial-done', { DialCallStatus: 'no-answer' }, { s: callId });
      expect(done.body).not.toContain('<Number');
      expect(done.body).not.toContain(offPlan.phone);
      expect(done.body).toContain("We couldn't reach them.");
      expect((await session(callId)).status).toBe('NOT_CONNECTED');
    } finally {
      await system(() => app.prisma.order.updateMany({ where: { riderId: offPlanRider }, data: { riderId: null } }));
      await system(() => app.prisma.rider.delete({ where: { id: offPlanRider } }));
    }
  });
});
