import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { rateLimitKey } from '../utils/rate-limit-key';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { stepUpKey } from '../modules/auth/step-up';
import { BillingService } from '../modules/billing/billing.service';
import { CARD_ON_FILE_CONSENT_VERSION, CardRailService } from '../modules/billing/card-rail.service';
import { CARD_CHECKOUT_PLATFORMS_KEY, resetCardCheckoutSwitchCache } from '../modules/billing/card-pay-action';
import {
  CARD_APP_RETURN_LINK,
  CARD_RAIL_RUNTIME_DECORATION,
  CARD_RETURN_BODY_LIMIT,
  CARD_RETURN_RATE,
  CARD_SESSION_START_RATE,
  cardRailPublicRoutes,
  type CardRailRuntime,
} from '../modules/billing/card-rail.routes';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxPaymentProvider } from '../providers/payment/payment-provider';
import { SIMULATOR_PAGE, SimulatorCardRailProvider, type SimulatorScenario } from '../providers/card/simulator-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { deleteRunKeys, runKeyPrefix } from './helpers/card-sim-keys';

// ---------------------------------------------------------------------------
// [PT-2] The card rail v2 ROUTES against the database and the real simulator
// (CARD-CHECKOUT-API.md). Everything is driven through HTTP, the way the app
// and the web drive it: open a session, press a button on the simulator's test
// page, follow the browser back to the public return, follow the session.
// The laws under test: a return is an observation that never credits by
// itself [C5]; only the provider's server-side answer enrols or books, once;
// sessions are one-use and bound to their partner [C8]; a card is brand,
// last 4 and expiry [C9]; the kill switch stops new sessions, never the
// draining of returns [C7]; outsiders are refused before anything is read.
// Phones: +592648… (checked unused in the monorepo).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const PREFIX = runKeyPrefix(RUN);
const ACCOUNT = `pt2-${RUN}`;
const SESSIONS = '/subscription/card-sessions';
const RETURN = '/api/v1/billing/card/return';
let app: FastifyInstance;
let redis: Redis;
let sim: SimulatorCardRailProvider;
let runtime: CardRailRuntime;
let kekBefore: string | undefined;

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_648_000_000 + Math.floor(Math.random() * 900_000);
const key = () => `tap-${nanoid(12)}`;

type Family = 'vendor' | 'rider' | 'driver';
type Actor = { userId: string; token: string; authSessionId: string };
type Partner = Actor & { subId: string; family: Family; vendorId?: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Card', lastName: `R${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `pt2-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, authSessionId: session.id };
}

type SubOpts = { status?: SubscriptionStatus; due?: Date };
function period(opts: SubOpts) {
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  return { currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due };
}

async function makeStore(opts: SubOpts = {}): Promise<Partner> {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: `Card Store ${seq}`, slug: `card-store-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
      addressLine1: '1 Card Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: { vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 2100, ...period(opts) },
  });
  subIds.push(sub.id);
  return { ...owner, subId: sub.id, family: 'vendor', vendorId: vendor.id };
}

async function makeRider(opts: SubOpts = {}): Promise<Partner> {
  const actor = await makeUser(['MOVER'], 'MOVER');
  const rider = await app.prisma.rider.create({ data: { userId: actor.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
  const sub = await app.prisma.subscription.create({
    data: { riderId: rider.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: 6000, ...period(opts) },
  });
  subIds.push(sub.id);
  return { ...actor, subId: sub.id, family: 'rider' };
}

async function makeDriver(opts: SubOpts = {}): Promise<Partner> {
  const actor = await makeUser(['MOVER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: actor.userId, vehicleType: 'CAR', documentsVerified: true, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
      vehicleColor: 'Silver', licensePlate: `HC-${RUN}-${seq}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins',
    },
  });
  const sub = await app.prisma.subscription.create({
    data: { driverId: driver.id, type: 'TAXI_DRIVER', status: opts.status ?? 'ACTIVE', weeklyRate: 7000, ...period(opts) },
  });
  subIds.push(sub.id);
  return { ...actor, subId: sub.id, family: 'driver' };
}

const headersOf = (p: Actor & { vendorId?: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${p.token}`,
  'x-client-platform': 'android',
  ...(p.vendorId ? { 'x-vendor-id': p.vendorId } : {}),
  ...extra,
});

const partnerCall = (p: Partner, method: 'GET' | 'POST' | 'DELETE', path: string, opts: { payload?: unknown; headers?: Record<string, string> } = {}) =>
  app.inject({
    method, url: `/api/v1/${p.family}${path}`,
    headers: headersOf(p, opts.headers),
    ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
  });

const startSession = (p: Partner, purpose: 'ENROLL' | 'PAY_NOW', opts: { key?: string; headers?: Record<string, string>; payload?: unknown } = {}) =>
  partnerCall(p, 'POST', SESSIONS, {
    payload: opts.payload ?? { purpose, ...(purpose === 'ENROLL' ? { consentVersion: CARD_ON_FILE_CONSENT_VERSION } : {}) },
    headers: { 'idempotency-key': opts.key ?? key(), ...opts.headers },
  });

/** The partner's browser on the simulator's page presses a button; answers where it is sent next. */
async function press(hostedUrl: string, scenario: SimulatorScenario) {
  const res = await app.inject({ method: 'POST', url: hostedUrl, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `scenario=${scenario}` });
  expect(res.statusCode, res.body).toBe(303);
  return res.headers['location'] as string;
}

/** The browser follows the provider's redirect back to Swift. */
const follow = (location: string) => app.inject({ method: 'GET', url: location });

/** The return address Swift gave the provider (the simulator keeps it), as the provider would use it. */
async function returnAddressOf(sessionId: string): Promise<string> {
  const row = await app.prisma.cardSession.findUniqueOrThrow({ where: { id: sessionId } });
  const url = await redis.hget(`${PREFIX}s:${row.providerSessionRef}`, 'returnUrl');
  expect(url).toMatch(/^\/api\/v1\/billing\/card\/return\?session=/);
  return url!;
}

async function money(subId: string) {
  const [sub, payments, successes, instruments] = await Promise.all([
    app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } }),
    app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } }),
    app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } }),
    app.prisma.paymentInstrument.findMany({ where: { subscriptionId: subId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { sub, payments, successes, instruments };
}

const observations = (sessionId: string) =>
  app.prisma.cardObservation.findMany({ where: { sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { source: true, parsedStatus: true, verdict: true } });

const pageState = (html: string) => {
  if (html.includes('<h1>Done</h1>')) return 'SUCCEEDED';
  if (html.includes('<h1>Checking with the bank</h1>')) return 'PENDING';
  if (html.includes("<h1>This didn&#39;t go through</h1>")) return 'FAILED';
  if (html.includes('<h1>Swift</h1>')) return 'UNKNOWN';
  return `UNRECOGNISED: ${html.slice(0, 200)}`;
};

const stepUp = (p: Actor) => redis.set(stepUpKey(p.authSessionId), '1', 'EX', 600);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  kekBefore = process.env['MASTER_KEK'];
  // A fresh random master key per run: the vault is really sealed, and nothing secret is written down.
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  process.env['CARD_RAIL_V2'] = '1';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(rateLimit, { keyGenerator: rateLimitKey((token) => app.jwt.verify(token)), max: 10_000, timeWindow: '1 minute' });
  redis = new Redis(process.env['REDIS_URL']!);
  sim = new SimulatorCardRailProvider(redis, { account: ACCOUNT, keyPrefix: PREFIX });
  const notifications = new NotificationService(app.prisma, app.io);
  const billing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), undefined, () => sim);
  runtime = { service: new CardRailService(app.prisma, notifications, billing, () => sim), billing, rail: () => sim };
  app.decorate(CARD_RAIL_RUNTIME_DECORATION, runtime);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(cardRailPublicRoutes, { prefix: '/api/v1/billing/card' });
  await app.ready();
});

afterEach(async () => {
  process.env['CARD_RAIL_V2'] = '1';
  delete process.env['CARD_RAIL_V2_DRAIN'];
  delete process.env['CARD_RAIL_KILL'];
  await app.prisma.platformConfig.deleteMany({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY } });
  resetCardCheckoutSwitchCache();
});

afterAll(async () => {
  delete process.env['CARD_RAIL_V2'];
  if (kekBefore === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = kekBefore;
  resetKeyProviderForTests();
  await runWithoutTenant(async () => {
    // Deleting the subscriptions cascades their cards, sessions and payments;
    // observations are append-only evidence and stay, keyed to this run's ids.
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }, 'test-cleanup:card-rail-routes');
  await deleteRunKeys(redis, PREFIX);
  await redis.quit();
  await app.close();
});

describe('Add card, end to end through HTTP: the return grants nothing; the provider’s answer adds the card, once', () => {
  it('rider: open → simulator page → Approve → return → card ACTIVE; a reload adds nothing; the card is brand / last 4 / expiry', async () => {
    const p = await makeRider();
    const before = await partnerCall(p, 'GET', '/subscription/cards');
    expect(before.statusCode, before.body).toBe(200);
    // The simulator never makes CARD live: no normal build shows a card button on a test page.
    expect(before.json().data).toEqual({ cards: [], payAction: { id: 'CARD', state: 'off' } });

    const k = key();
    const opened = await startSession(p, 'ENROLL', { key: k });
    expect(opened.statusCode, opened.body).toBe(201);
    const session = opened.json().data;
    expect(session).toMatchObject({ purpose: 'ENROLL', status: 'OPEN', testMode: true, testModeLabel: SIMULATOR_PAGE.testModeLabel });
    expect(session.hostedUrl).toMatch(/^\/api\/v1\/billing\/card\/simulator\/sim_[0-9a-f]{24}$/);
    // The same tap again: the same session, 200.
    const again = await startSession(p, 'ENROLL', { key: k });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.sessionId).toBe(session.sessionId);

    // The test page: labelled, four buttons, no input of any kind [C10].
    const pageRes = await app.inject({ method: 'GET', url: session.hostedUrl });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.headers['cache-control']).toBe('no-store');
    expect(pageRes.body).toContain(SIMULATOR_PAGE.testModeLabel);
    expect(pageRes.body.match(/<button /g)).toHaveLength(4);
    expect(pageRes.body).not.toMatch(/<input|<textarea|<select/i);

    const location = await press(session.hostedUrl, 'APPROVE');
    expect(location.startsWith(`${RETURN}?session=${session.sessionId}&state=`)).toBe(true);
    // Pressing a button grants nothing either.
    expect((await money(p.subId)).instruments).toHaveLength(0);

    const back = await follow(location);
    expect(back.statusCode).toBe(200);
    expect(pageState(back.body)).toBe('SUCCEEDED');
    expect(back.headers['cache-control']).toBe('no-store');
    expect(back.headers['x-robots-tag']).toBe('noindex');
    expect(back.headers['referrer-policy']).toBe('no-referrer');
    // The page carries no amount, card or id; one plain link back to the app.
    expect(back.body).not.toContain(session.sessionId);
    expect(back.body).not.toMatch(/4242|SIMULATED/);
    expect(back.body).toContain(`href="${CARD_APP_RETURN_LINK}"`);

    const { instruments, sub } = await money(p.subId);
    expect(instruments).toHaveLength(1);
    expect(instruments[0]).toMatchObject({ status: 'ACTIVE', last4: '4242', provider: 'simulator', providerAccount: ACCOUNT });
    expect(sub.billingMethod).toBe('CARD');

    // A reload of the return (a replay) shows the same page and adds nothing.
    const reload = await follow(location);
    expect(pageState(reload.body)).toBe('SUCCEEDED');
    expect((await money(p.subId)).instruments).toHaveLength(1);
    expect(await observations(session.sessionId)).toEqual([
      { source: 'RETURN', parsedStatus: 'SUCCEEDED', verdict: 'ACCEPTED' },
      { source: 'CONFIRM', parsedStatus: 'SUCCEEDED', verdict: 'ACCEPTED' },
      { source: 'RETURN', parsedStatus: 'SUCCEEDED', verdict: 'REJECTED_REPLAY' },
    ]);

    const followed = await partnerCall(p, 'GET', `${SESSIONS}/${session.sessionId}`);
    expect(followed.statusCode).toBe(200);
    expect(followed.json().data).toMatchObject({ sessionId: session.sessionId, purpose: 'ENROLL', status: 'SUCCEEDED', subscriptionStatus: 'ACTIVE', testMode: true });
    expect(Object.keys(followed.json().data.card).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'last4', 'status']);
    expect(followed.json().data).not.toHaveProperty('hostedUrl');

    const listed = await partnerCall(p, 'GET', '/subscription/cards');
    expect(listed.json().data.cards).toHaveLength(1);
    expect(Object.keys(listed.json().data.cards[0]).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'last4', 'status']);
  });

  it('removing a card needs a step-up, REVOKES it at once, and is idempotent; another partner’s card is 404', async () => {
    const p = await makeDriver();
    const opened = (await startSession(p, 'ENROLL')).json().data;
    expect(pageState((await follow(await press(opened.hostedUrl, 'APPROVE'))).body)).toBe('SUCCEEDED');
    const [card] = (await money(p.subId)).instruments;

    const noStepUp = await partnerCall(p, 'DELETE', `/subscription/cards/${card!.id}`);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await money(p.subId)).instruments[0]!.status).toBe('ACTIVE');

    const outsider = await makeRider();
    await stepUp(outsider);
    const theirs = await partnerCall(outsider, 'DELETE', `/subscription/cards/${card!.id}`);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json().error.code).toBe('CARD_NOT_FOUND');
    expect((await money(p.subId)).instruments[0]!.status).toBe('ACTIVE');

    await stepUp(p);
    const removed = await partnerCall(p, 'DELETE', `/subscription/cards/${card!.id}`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().data).toMatchObject({ card: { id: card!.id, status: 'REVOKED' }, paymentInProgress: false });
    const twice = await partnerCall(p, 'DELETE', `/subscription/cards/${card!.id}`);
    expect(twice.statusCode).toBe(200);
    expect(twice.json().data.card.status).toBe('REVOKED');
    expect(await app.prisma.auditLog.count({ where: { action: 'CARD_REMOVED', entityId: card!.id } })).toBe(1);
  });
});

describe('Pay now through HTTP: priced by the server, booked once, and only on the provider’s answer', () => {
  it('store owner: the server prices it; Approve books the week ONCE; a replayed return books nothing more', async () => {
    const p = await makeStore();
    const opened = await startSession(p, 'PAY_NOW');
    expect(opened.statusCode, opened.body).toBe(201);
    const session = opened.json().data;
    const quote = await runtime.billing.quoteCardPayNow(p.subId);
    expect(session).toMatchObject({ purpose: 'PAY_NOW', amount: quote.amount, currencyCode: quote.currencyCode });
    const periodEndBefore = (await money(p.subId)).sub.currentPeriodEnd.getTime();

    const location = await press(session.hostedUrl, 'APPROVE');
    expect((await money(p.subId)).successes).toBe(0);
    expect(pageState((await follow(location)).body)).toBe('SUCCEEDED');
    const after = await money(p.subId);
    expect(after.successes).toBe(1);
    expect(after.payments.filter((x) => x.status === 'SUCCEEDED')).toHaveLength(1);
    expect(after.sub.currentPeriodEnd.getTime()).toBe(periodEndBefore + 7 * DAY);

    for (let i = 0; i < 3; i += 1) expect(pageState((await follow(location)).body)).toBe('SUCCEEDED');
    await runtime.service.confirm(session.sessionId);
    const later = await money(p.subId);
    expect(later.successes).toBe(1);
    expect(later.sub.currentPeriodEnd.getTime()).toBe(periodEndBefore + 7 * DAY);
  });

  it('a client cannot name the amount, or send anything that is not the contract (a card number least of all): 400, nothing opened', async () => {
    const p = await makeRider();
    for (const payload of [
      { purpose: 'PAY_NOW', amount: 1 },
      { purpose: 'PAY_NOW', cardNumber: '4111111111111111' },
      { purpose: 'ENROLL', consentVersion: CARD_ON_FILE_CONSENT_VERSION, cvv: '123' },
      { purpose: 'REFUND' },
    ]) {
      const res = await startSession(p, 'PAY_NOW', { payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CARD_SESSION');
    }
    const noKey = await partnerCall(p, 'POST', SESSIONS, { payload: { purpose: 'PAY_NOW' } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const shortKey = await startSession(p, 'PAY_NOW', { key: 'short' });
    expect(shortKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const noConsent = await startSession(p, 'ENROLL', { payload: { purpose: 'ENROLL' } });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json().error.code).toBe('CARD_CONSENT_REQUIRED');
    expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(0);
  });

  it('[C5] a return that CLAIMS approval while the provider says nothing happened credits nothing', async () => {
    const p = await makeRider();
    const session = (await startSession(p, 'PAY_NOW')).json().data;
    // No button was pressed: the provider's truth is "pending". The browser claims approval anyway.
    const forged = `${await returnAddressOf(session.sessionId)}&sim_outcome=approve&sim_ref=whatever`;
    expect(pageState((await follow(forged)).body)).toBe('PENDING');
    const m = await money(p.subId);
    expect(m.successes).toBe(0);
    expect(m.payments).toHaveLength(0);
    expect((await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status).toBe('OPEN');
  });

  it('a wrong or missing state, an unknown session, or an ambiguous return: an UNKNOWN page and nothing granted', async () => {
    const p = await makeRider();
    const session = (await startSession(p, 'PAY_NOW')).json().data;
    const location = await press(session.hostedUrl, 'APPROVE');
    const wrongState = location.replace(/state=[^&]+/, `state=${'A'.repeat(43)}`);
    expect(pageState((await follow(wrongState)).body)).toBe('UNKNOWN');
    expect(pageState((await follow(location.replace(/state=[^&]+&?/, ''))).body)).toBe('UNKNOWN');
    expect(pageState((await follow(location.replace(/session=[^&]+/, 'session=nosuchsession'))).body)).toBe('UNKNOWN');
    // The same name twice is ambiguous: refused before it is read or written down.
    expect(pageState((await follow(`${location}&sim_outcome=decline`)).body)).toBe('UNKNOWN');
    expect((await money(p.subId)).successes).toBe(0);
    expect(await observations(session.sessionId)).toEqual([{ source: 'RETURN', parsedStatus: 'INVALID', verdict: 'REJECTED_STATE' }]);
    // The real return still works afterwards: nothing above spent it.
    expect(pageState((await follow(location)).body)).toBe('SUCCEEDED');
    expect((await money(p.subId)).successes).toBe(1);
  });

  it('Decline: a FAILED page, nothing booked; Time out: PENDING, then the provider’s late answer books it once', async () => {
    const p = await makeRider();
    const declined = (await startSession(p, 'PAY_NOW')).json().data;
    expect(pageState((await follow(await press(declined.hostedUrl, 'DECLINE'))).body)).toBe('FAILED');
    expect((await money(p.subId)).successes).toBe(0);

    const slow = (await startSession(p, 'PAY_NOW')).json().data;
    expect(pageState((await follow(await press(slow.hostedUrl, 'TIMEOUT'))).body)).toBe('PENDING');
    expect((await money(p.subId)).successes).toBe(0);
    const view = await partnerCall(p, 'GET', `${SESSIONS}/${slow.sessionId}`);
    expect(view.json().data.status).toBe('OPEN');
    // The sweep (or any later confirmation) asks the provider again: booked once.
    expect((await runtime.service.confirm(slow.sessionId)).status).toBe('SUCCEEDED');
    expect((await runtime.service.confirm(slow.sessionId)).status).toBe('SUCCEEDED');
    expect((await money(p.subId)).successes).toBe(1);
  });

  it('a return posted as a JSON or form body is read the same way; a body over 16 KB is refused unread', async () => {
    const p = await makeRider();
    const session = (await startSession(p, 'ENROLL')).json().data;
    const location = await press(session.hostedUrl, 'DECLINE');
    const [path, query] = location.split('?') as [string, string];
    const params = new URLSearchParams(query);
    const own = `${path}?session=${params.get('session')}&state=${params.get('state')}`;
    const tooBig = await app.inject({ method: 'POST', url: own, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ sim_outcome: 'decline', pad: 'x'.repeat(CARD_RETURN_BODY_LIMIT) }) });
    expect(tooBig.statusCode).toBe(413);
    expect(await observations(session.sessionId)).toEqual([]);
    const posted = await app.inject({ method: 'POST', url: own, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `sim_ref=${params.get('sim_ref')}&sim_outcome=decline` });
    expect(posted.statusCode).toBe(200);
    expect(pageState(posted.body)).toBe('FAILED');
    expect(await observations(session.sessionId)).toEqual([
      { source: 'RETURN', parsedStatus: 'FAILED', verdict: 'ACCEPTED' },
      { source: 'CONFIRM', parsedStatus: 'FAILED', verdict: 'ACCEPTED' },
    ]);
  });
});

describe('who may do what: the family’s own gate first, then the session’s owner', () => {
  it('no token is 401 and another role is 403 on every card route — before any key, body or id is read', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER'], 'MOVER');
    const vendorOwner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const routes: Array<['GET' | 'POST' | 'DELETE', string]> = [
      ['GET', '/subscription/cards'], ['DELETE', '/subscription/cards/x'], ['POST', SESSIONS], ['GET', `${SESSIONS}/x`],
    ];
    for (const family of ['vendor', 'rider', 'driver'] as const) {
      const wrong = family === 'vendor' ? [customer, mover] : [customer, vendorOwner];
      for (const [method, path] of routes) {
        const url = `/api/v1/${family}${path}`;
        const anon = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(anon.statusCode, `${method} ${url} anonymous`).toBe(401);
        for (const actor of wrong) {
          const res = await app.inject({ method, url, headers: { authorization: `Bearer ${actor.token}` }, ...(method === 'POST' ? { payload: {} } : {}) });
          expect(res.statusCode, `${method} ${url} as a wrong role`).toBe(403);
        }
      }
    }
  });

  it('a store MANAGER is refused the card routes: billing is the OWNER’s', async () => {
    const store = await makeStore();
    const manager = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    await app.prisma.vendorStaff.create({ data: { vendorId: store.vendorId!, userId: manager.userId, role: 'MANAGER', invitedBy: store.userId } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/vendor/subscription/cards', headers: headersOf({ ...manager, vendorId: store.vendorId }) });
    expect(res.statusCode).toBe(403);
    await app.prisma.vendorStaff.deleteMany({ where: { userId: manager.userId } });
  });

  it('[C8] another partner’s session is 404, exactly like one that does not exist', async () => {
    const a = await makeRider();
    const b = await makeRider();
    const session = (await startSession(a, 'ENROLL')).json().data;
    const res = await partnerCall(b, 'GET', `${SESSIONS}/${session.sessionId}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CARD_SESSION_NOT_FOUND');
    expect((await partnerCall(b, 'GET', `${SESSIONS}/nosuchsession`)).json().error.code).toBe('CARD_SESSION_NOT_FOUND');
  });
});

describe('the switches: the flag, the kill switch, the platform, the subscription', () => {
  it('CARD_RAIL_V2 off: no session opens, the return is inert (nothing read or written), the simulator page is gone', async () => {
    const p = await makeRider();
    const session = (await startSession(p, 'PAY_NOW')).json().data;
    const location = await press(session.hostedUrl, 'APPROVE');
    process.env['CARD_RAIL_V2'] = '0';
    const refused = await startSession(p, 'PAY_NOW');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('PAY_ACTION_OFF');
    expect(pageState((await follow(location)).body)).toBe('UNKNOWN');
    expect(await observations(session.sessionId)).toEqual([]);
    expect((await app.inject({ method: 'GET', url: session.hostedUrl })).statusCode).toBe(404);
    expect((await money(p.subId)).successes).toBe(0);
    // Draining (CARD_RAIL_V2_DRAIN=1) finishes what is in flight, and opens nothing new.
    process.env['CARD_RAIL_V2_DRAIN'] = '1';
    expect((await startSession(p, 'PAY_NOW')).statusCode).toBe(409);
    expect(pageState((await follow(location)).body)).toBe('SUCCEEDED');
    expect((await money(p.subId)).successes).toBe(1);
  });

  it('[C7] the kill switch stops new sessions (503) but never the return already on its way', async () => {
    const p = await makeRider();
    const session = (await startSession(p, 'PAY_NOW')).json().data;
    const location = await press(session.hostedUrl, 'APPROVE');
    process.env['CARD_RAIL_KILL'] = '1';
    const refused = await startSession(p, 'ENROLL');
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('CARD_RAIL_DISABLED');
    expect(pageState((await follow(location)).body)).toBe('SUCCEEDED');
    expect((await money(p.subId)).successes).toBe(1);
  });

  it('the platform switch: iOS is off unless switched on; Android and web are on unless switched off', async () => {
    const p = await makeRider();
    const ios = await startSession(p, 'ENROLL', { headers: { 'x-client-platform': 'ios' } });
    expect(ios.statusCode).toBe(409);
    expect(ios.json().error.code).toBe('PAY_ACTION_OFF');
    const unknownPlatform = await startSession(p, 'ENROLL', { headers: { 'x-client-platform': 'toaster' } });
    expect(unknownPlatform.statusCode).toBe(409);
    await app.prisma.platformConfig.create({ data: { key: CARD_CHECKOUT_PLATFORMS_KEY, value: { ios: true, web: false } } });
    resetCardCheckoutSwitchCache();
    expect((await startSession(p, 'ENROLL', { headers: { 'x-client-platform': 'ios' } })).statusCode).toBe(201);
    expect((await startSession(p, 'PAY_NOW', { headers: { 'x-client-platform': 'web' } })).json().error.code).toBe('PAY_ACTION_OFF');
  });

  it('a subscription that cannot pay (billing stopped, or waived) opens no card page', async () => {
    const paused = await makeRider({ status: 'PAUSED' });
    expect((await startSession(paused, 'PAY_NOW')).json().error.code).toBe('PAY_ACTION_OFF');
    const waived = await makeRider();
    await app.prisma.subscription.update({ where: { id: waived.subId }, data: { feeWaived: true } });
    expect((await startSession(waived, 'PAY_NOW')).json().error.code).toBe('PAY_ACTION_OFF');
    expect(await app.prisma.cardSession.count({ where: { subscriptionId: { in: [paused.subId, waived.subId] } } })).toBe(0);
  });
});

describe('rate limits', () => {
  it(`opening card sessions: at most ${CARD_SESSION_START_RATE.max} a minute per partner, then 429 RATE_LIMITED`, async () => {
    const p = await makeRider();
    const k = key(); // the same tap, retried: cheap, but still counted
    const codes: number[] = [];
    for (let i = 0; i < CARD_SESSION_START_RATE.max + 1; i += 1) codes.push((await startSession(p, 'ENROLL', { key: k })).statusCode);
    expect(codes.slice(0, CARD_SESSION_START_RATE.max).every((c) => c === 201 || c === 200)).toBe(true);
    expect(codes[CARD_SESSION_START_RATE.max]).toBe(429);
  });

  it(`the public return: at most ${CARD_RETURN_RATE.max} a minute per address, then 429`, async () => {
    let last = 0;
    for (let i = 0; i < CARD_RETURN_RATE.max + 1; i += 1) last = (await app.inject({ method: 'GET', url: `${RETURN}?session=x&state=y`, remoteAddress: '203.0.113.77' })).statusCode;
    expect(last).toBe(429);
  });
});

describe('the return never writes its address to a log', () => {
  it('the request line, its state and its parameters stay out of the log, while other routes still log', async () => {
    let out = '';
    const sink = new Writable({ write(chunk, _enc, cb) { out += String(chunk); cb(); } });
    const logged = Fastify({ logger: { level: 'info', stream: sink } });
    registerErrorHandler(logged);
    await logged.register(prismaPlugin);
    await logged.register(redisPlugin);
    await logged.register(authPlugin);
    await logged.register(socketPlugin);
    logged.decorate(CARD_RAIL_RUNTIME_DECORATION, runtime);
    await logged.register(cardRailPublicRoutes, { prefix: '/api/v1/billing/card' });
    logged.get('/ping-pt2', async () => ({ ok: true }));
    await logged.ready();
    try {
      const p = await makeRider();
      const session = (await startSession(p, 'PAY_NOW')).json().data;
      const location = await press(session.hostedUrl, 'APPROVE');
      const state = new URLSearchParams(location.split('?')[1]).get('state')!;
      expect(pageState((await logged.inject({ method: 'GET', url: location })).body)).toBe('SUCCEEDED');
      await logged.inject({ method: 'GET', url: `${RETURN}?session=${session.sessionId}&state=${'B'.repeat(43)}&secret=zzz` });
      await logged.inject({ method: 'GET', url: session.hostedUrl });
      await logged.inject({ method: 'GET', url: '/ping-pt2' });
      expect(out).toContain('/ping-pt2'); // the sink really captures request lines
      expect(out).not.toContain(state);
      expect(out).not.toContain('/billing/card/return');
      expect(out).not.toContain('/billing/card/simulator');
      expect(out).not.toContain('zzz');
    } finally {
      await logged.close();
    }
  });
});

describe('admin read views: evidence as hashes, never anything that moves money', () => {
  async function makeAdmin(role: 'ADMIN' | 'SUPER_ADMIN' = 'SUPER_ADMIN') {
    return makeUser([role, 'CUSTOMER'], role);
  }

  it('the sessions list, one session with its observations, and a subscription’s cards', async () => {
    const p = await makeRider();
    const session = (await startSession(p, 'ENROLL')).json().data;
    expect(pageState((await follow(await press(session.hostedUrl, 'APPROVE'))).body)).toBe('SUCCEEDED');
    const admin = await makeAdmin();
    const call = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${admin.token}` } });

    const list = await call(`/api/v1/admin/billing/card-sessions?subscriptionId=${p.subId}`);
    expect(list.statusCode, list.body).toBe(200);
    const [row] = list.json().data.sessions;
    expect(row).toMatchObject({ id: session.sessionId, purpose: 'ENROLL', status: 'SUCCEEDED', provider: 'simulator', providerAccount: ACCOUNT });
    for (const hidden of ['stateHash', 'hostedUrl', 'providerSessionRef', 'idempotencyKey']) expect(row, hidden).not.toHaveProperty(hidden);

    const one = await call(`/api/v1/admin/billing/card-sessions/${session.sessionId}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().data.observations.map((o: { source: string; verdict: string }) => `${o.source}:${o.verdict}`)).toEqual(['RETURN:ACCEPTED', 'CONFIRM:ACCEPTED']);
    for (const o of one.json().data.observations) expect(o.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(one.json())).not.toMatch(/simtok_|sim_[0-9a-f]{24}|returnUrl|state=/);

    const cards = await call(`/api/v1/admin/billing/subscriptions/${p.subId}/cards`);
    expect(cards.statusCode).toBe(200);
    expect(cards.json().data.cards[0]).toMatchObject({ last4: '4242', status: 'ACTIVE', consentVersion: CARD_ON_FILE_CONSENT_VERSION });
    for (const hidden of ['vaultTokenSealed', 'vaultTokenDek']) expect(cards.json().data.cards[0], hidden).not.toHaveProperty(hidden);
    expect((await call('/api/v1/admin/billing/card-sessions/no-such-session')).statusCode).toBe(404);
  });

  it('a partner token is refused the admin views', async () => {
    const p = await makeRider();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/billing/card-sessions', headers: { authorization: `Bearer ${p.token}` } });
    expect(res.statusCode).toBe(403);
  });
});
