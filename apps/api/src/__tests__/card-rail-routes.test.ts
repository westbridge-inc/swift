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
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { rateLimitKey } from '../utils/rate-limit-key';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { stepUpKey } from '../modules/auth/step-up';
import { BillingService } from '../modules/billing/billing.service';
import { readDunningClock } from '../modules/billing/dunning-clock';
import { CARD_ON_FILE_CONSENT_VERSION, CardRailService } from '../modules/billing/card-rail.service';
import { CARD_CHECKOUT_PLATFORMS_KEY, resetCardCheckoutSwitchCache } from '../modules/billing/card-pay-action';
import {
  CARD_APP_RETURN_LINK,
  CARD_RAIL_RUNTIME_DECORATION,
  CARD_RETURN_BODY_LIMIT,
  CARD_RETURN_RATE,
  CARD_RETURN_PAGES,
  CARD_SESSION_START_RATE,
  cardWebFeeUrl,
  cardRailPublicRoutes,
  returnPageHtml,
  type CardRailRuntime,
} from '../modules/billing/card-rail.routes';
import { NotificationService } from '../modules/notification/notification.service';
import { REVIEW_DEMO_NO_MONEY } from '../modules/review/demo-policy';
import { SandboxPaymentProvider } from '../providers/payment/payment-provider';
import type { CardRailProvider } from '../providers/card/card-provider';
import { SIMULATOR_PAGE, SimulatorCardRailProvider, type SimulatorScenario } from '../providers/card/simulator-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
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
// draining of returns [C7]; outsiders are refused before anything is read;
// the store-review demo reaches no card surface; the server alone says, per
// platform, whether the Pay screen shows a card button (payActions CARD).
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
/** What the ROUTES see as the configured provider (the service keeps the simulator). */
let railOverride: CardRailProvider | null = null;

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;
const phoneBase = 592_648_000_000 + Math.floor(Math.random() * 900_000);
const key = () => `tap-${nanoid(12)}`;

type Family = 'vendor' | 'rider' | 'driver';
type Actor = { userId: string; token: string; authSessionId: string };
type Partner = Actor & { subId: string; family: Family; vendorId?: string };

/** Fixtures are written in an explicit tenant scope: `tenantId`'s, or none (the schema's production tenant). */
const inTenant = <T>(tenantId: string | undefined, fn: () => Promise<T>) => (tenantId ? runWithTenant(tenantId, fn) : runWithoutTenant(fn, 'pt2-card-test-fixture'));

async function makeUser(roles: UserRole[], activeRole: UserRole, tenantId?: string): Promise<Actor> {
  seq += 1;
  const user = await inTenant(tenantId, () => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Card', lastName: `R${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(tenantId ? { tenantId } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `pt2-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, authSessionId: session.id };
}

/** `tenantId`: the partner's tenant (default: production). `mapped: false`: the shared billing
 *  confirmation clock has not mapped the subscription yet ([#1393]; reading never maps it). */
type SubOpts = { status?: SubscriptionStatus; due?: Date; tenantId?: string; mapped?: boolean; simulatorTest?: boolean };
function period(opts: SubOpts) {
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  return { currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due };
}
/** [Review S2] The simulator serves only listed TEST subscriptions: fixtures are listed unless a test says
 *  `simulatorTest: false` (a real partner on a test server). */
const simulatorTestSubs: string[] = [];
async function mappedUnless<T extends { subId: string }>(partner: T, opts: SubOpts): Promise<T> {
  if (opts.mapped !== false) await inTenant(opts.tenantId, () => readDunningClock(app.prisma, partner.subId));
  if (opts.simulatorTest !== false) {
    simulatorTestSubs.push(partner.subId);
    process.env['CARD_RAIL_SIMULATOR_SUBSCRIPTIONS'] = simulatorTestSubs.join(',');
  }
  return partner;
}

async function makeStore(opts: SubOpts = {}): Promise<Partner> {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER', opts.tenantId);
  const { vendorId, subId } = await inTenant(opts.tenantId, async () => {
    const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: ownerRow.id, name: `Card Store ${seq}`, slug: `card-store-${nanoid(6).toLowerCase()}`,
        vendorType: 'RESTAURANT', phone: `+${phoneBase + 5000 + seq}`,
        addressLine1: '1 Card Street', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      },
    });
    vendorIds.push(vendor.id);
    const sub = await app.prisma.subscription.create({
      data: { vendorId: vendor.id, type: 'RESTAURANT', status: opts.status ?? 'ACTIVE', weeklyRate: 2100, ...period(opts), prepaidBalance: { create: { balance: 0 } } },
    });
    subIds.push(sub.id);
    return { vendorId: vendor.id, subId: sub.id };
  });
  return mappedUnless({ ...owner, subId, family: 'vendor' as const, vendorId }, opts);
}

async function makeRider(opts: SubOpts = {}): Promise<Partner> {
  const actor = await makeUser(['MOVER'], 'MOVER', opts.tenantId);
  const subId = await inTenant(opts.tenantId, async () => {
    const rider = await app.prisma.rider.create({ data: { userId: actor.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
    const sub = await app.prisma.subscription.create({
      data: { riderId: rider.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: 6000, ...period(opts), prepaidBalance: { create: { balance: 0 } } },
    });
    subIds.push(sub.id);
    return sub.id;
  });
  return mappedUnless({ ...actor, subId, family: 'rider' as const }, opts);
}

async function makeDriver(opts: SubOpts = {}): Promise<Partner> {
  const actor = await makeUser(['MOVER'], 'MOVER', opts.tenantId);
  const subId = await inTenant(opts.tenantId, async () => {
    const driver = await app.prisma.driver.create({
      data: {
        userId: actor.userId, vehicleType: 'CAR', documentsVerified: true, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
        vehicleColor: 'Silver', licensePlate: `HC-${RUN}-${seq}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins',
      },
    });
    const sub = await app.prisma.subscription.create({
      data: { driverId: driver.id, type: 'TAXI_DRIVER', status: opts.status ?? 'ACTIVE', weeklyRate: 7000, ...period(opts), prepaidBalance: { create: { balance: 0 } } },
    });
    subIds.push(sub.id);
    return sub.id;
  });
  return mappedUnless({ ...actor, subId, family: 'driver' as const }, opts);
}

/** The store-review demo tenant: its requests pass the review gate while a review session is live. */
async function makeReviewTenant(): Promise<string> {
  const id = `pt2-review-${nanoid(6).toLowerCase()}`;
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id, slug: id, name: 'Card rail review fiction', kind: 'REVIEW', isActive: true } }), 'pt2-card-test-fixture');
  tenantIds.push(id);
  await runWithTenant(id, () => app.prisma.reviewSession.create({ data: { tenantId: id, expiresAt: new Date(Date.now() + DAY) } }));
  return id;
}

/** A provider the routes treat as REAL (never the simulator): it answers with the simulator's truth. */
function realProvider(opts: { savesCards: boolean }): CardRailProvider {
  return {
    binding: sim.binding,
    simulator: false,
    savesCards: opts.savesCards,
    createSession: (i) => sim.createSession(i),
    parseReturn: (params) => sim.parseReturn(params),
    confirm: (i) => sim.confirm(i),
    chargeInstrument: (i) => sim.chargeInstrument(i),
    retrieve: (i) => sim.retrieve(i),
    refund: (i) => sim.refund(i),
  };
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

/** The CARD entry of GET /{family}/subscription's payActions. */
async function cardActionOf(p: Partner, headers: Record<string, string> = {}) {
  const res = await partnerCall(p, 'GET', '/subscription', { headers });
  expect(res.statusCode, res.body).toBe(200);
  const actions = res.json().data.payActions as Array<{ id: string }>;
  expect(actions.map((a) => a.id)).toEqual(['MMG_CHECKOUT', 'CARD']);
  return actions[1] as Record<string, unknown>;
}

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
  // Saving cards is its own switch (owner sign-off on the consent words); these tests drive it on.
  process.env['CARD_RAIL_ENROLL'] = '1';
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
  runtime = { service: new CardRailService(app.prisma, notifications, billing, () => sim), billing, rail: () => railOverride ?? sim };
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
  process.env['CARD_RAIL_ENROLL'] = '1';
  delete process.env['CARD_RAIL_V2_DRAIN'];
  delete process.env['CARD_RAIL_KILL'];
  delete process.env['CARD_RAIL_SIMULATOR_LIVE'];
  railOverride = null;
  await app.prisma.platformConfig.deleteMany({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY } });
  resetCardCheckoutSwitchCache();
});

afterAll(async () => {
  delete process.env['CARD_RAIL_V2'];
  delete process.env['CARD_RAIL_ENROLL'];
  delete process.env['CARD_RAIL_SIMULATOR_SUBSCRIPTIONS'];
  if (kekBefore === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = kekBefore;
  resetKeyProviderForTests();
  await runWithoutTenant(async () => {
    // [#1393] The shared confirmation clock's evidence (holds, notices, transitions, clocks) goes first.
    await cleanupBillingClocks(app.prisma, subIds);
    // Deleting the subscriptions cascades their cards, sessions and payments;
    // observations are append-only evidence and stay, keyed to this run's ids.
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    // [#1393] A mover's fee authority lives exactly as long as its payer and names the canonical
    // subscription: the mover payers go first, then the subscriptions.
    const payers = await app.prisma.moverFeeAuthority.findMany({ where: { userId: { in: userIds } }, select: { userId: true } });
    await app.prisma.user.deleteMany({ where: { id: { in: payers.map((a) => a.userId) } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
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
      // The session is no longer open: the closed-session verdict comes before the replay check.
      { source: 'RETURN', parsedStatus: 'SUCCEEDED', verdict: 'REJECTED_CLOSED' },
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

describe('the same tap again: the same session, and its page while it is open', () => {
  it('PAY_NOW and ENROLL: the same Idempotency-Key answers 200 with the same session AND its page address while open; never once it is closed', async () => {
    const p = await makeRider();
    for (const purpose of ['PAY_NOW', 'ENROLL'] as const) {
      const k = key();
      const first = await startSession(p, purpose, { key: k });
      expect(first.statusCode, first.body).toBe(201);
      const again = await startSession(p, purpose, { key: k });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().data).toMatchObject({ sessionId: first.json().data.sessionId, status: 'OPEN', hostedUrl: first.json().data.hostedUrl });
      expect(again.json().data.hostedUrl).toMatch(/^\/api\/v1\/billing\/card\/simulator\/sim_[0-9a-f]{24}$/);
      // Finished: the page cannot be opened again from a replay.
      expect(pageState((await follow(await press(first.json().data.hostedUrl, 'APPROVE'))).body)).toBe('SUCCEEDED');
      const after = await startSession(p, purpose, { key: k });
      expect(after.statusCode).toBe(200);
      expect(after.json().data).toMatchObject({ sessionId: first.json().data.sessionId, status: 'SUCCEEDED', hostedUrl: null });
    }
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
    expect(after.payments.filter((x) => x.status === 'CAPTURED')).toHaveLength(1);
    expect(after.sub.currentPeriodEnd.getTime()).toBe(periodEndBefore + 7 * DAY);
    // The partner's view says what happened to the money: the paid week moved.
    const followed = (await partnerCall(p, 'GET', `${SESSIONS}/${session.sessionId}`)).json().data;
    expect(followed).toMatchObject({ status: 'SUCCEEDED', settlement: 'advanced', amount: quote.amount, currencyCode: quote.currencyCode });

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
    // Written down with what the browser claimed, and refused at the state check: nothing more is read.
    expect(await observations(session.sessionId)).toEqual([{ source: 'RETURN', parsedStatus: 'SUCCEEDED', verdict: 'REJECTED_STATE' }]);
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

  it('[REVIEW-PARTNER] the store-review demo reaches no card route, in any family: 403 REVIEW_DEMO_NO_MONEY, nothing opened', async () => {
    const review = await makeReviewTenant();
    for (const p of [await makeStore({ tenantId: review }), await makeRider({ tenantId: review }), await makeDriver({ tenantId: review })]) {
      for (const [method, path, payload] of [
        ['GET', '/subscription/cards', undefined],
        ['DELETE', '/subscription/cards/somecard', undefined],
        ['GET', `${SESSIONS}/somesession`, undefined],
        ['POST', SESSIONS, { purpose: 'PAY_NOW' }],
      ] as const) {
        const res = await partnerCall(p, method, path, { ...(payload ? { payload } : {}), headers: { 'idempotency-key': key() } });
        expect(res.statusCode, `${p.family} ${method} ${path}: ${res.body}`).toBe(403);
        expect(res.json().error.code).toBe(REVIEW_DEMO_NO_MONEY);
      }
      // Its subscription payload never shows a card button either.
      expect(await cardActionOf(p)).toEqual({ id: 'CARD', state: 'off' });
      expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(0);
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

  it('[DS633, as MMG] only a real true/false counts: any other value switches that platform off, and a row that is not an object switches every platform off', async () => {
    const p = await makeRider();
    await app.prisma.platformConfig.create({ data: { key: CARD_CHECKOUT_PLATFORMS_KEY, value: { ios: 'true', android: 'false' } } });
    resetCardCheckoutSwitchCache();
    expect((await startSession(p, 'ENROLL', { headers: { 'x-client-platform': 'ios' } })).json().error.code).toBe('PAY_ACTION_OFF');
    expect((await startSession(p, 'ENROLL', { headers: { 'x-client-platform': 'android' } })).json().error.code).toBe('PAY_ACTION_OFF');
    expect((await startSession(p, 'ENROLL', { headers: { 'x-client-platform': 'web' } })).statusCode).toBe(201);
    await app.prisma.platformConfig.update({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY }, data: { value: ['ios', 'android', 'web'] } });
    resetCardCheckoutSwitchCache();
    for (const platform of ['ios', 'android', 'web']) {
      expect((await startSession(p, 'PAY_NOW', { headers: { 'x-client-platform': platform } })).json().error.code, platform).toBe('PAY_ACTION_OFF');
    }
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

describe('Add card needs a provider that can charge a saved card each week', () => {
  it('a provider that cannot save cards: ENROLL is 409 ADD_CARD_OFF before any page or row; Pay now still opens', async () => {
    railOverride = realProvider({ savesCards: false });
    const p = await makeRider();
    const refused = await startSession(p, 'ENROLL');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('ADD_CARD_OFF');
    expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(0);
    const payNow = await startSession(p, 'PAY_NOW');
    expect(payNow.statusCode, payNow.body).toBe(201);
    expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId, purpose: 'ENROLL' } })).toBe(0);
  });
});

describe('payActions CARD: the server alone decides, per platform, whether the Pay screen shows a card button', () => {
  it('flag off, or the simulator (a test page), or no provider: CARD is off in every family’s subscription payload', async () => {
    const parts = [await makeStore(), await makeRider(), await makeDriver()];
    for (const p of parts) expect(await cardActionOf(p), `${p.family} on the simulator`).toEqual({ id: 'CARD', state: 'off' });
    railOverride = realProvider({ savesCards: false });
    process.env['CARD_RAIL_V2'] = '0';
    for (const p of parts) expect(await cardActionOf(p), `${p.family} with the flag off`).toEqual({ id: 'CARD', state: 'off' });
  });

  it('a real provider: live with the server’s Pay-now price in every family; Add card only when the provider saves cards', async () => {
    railOverride = realProvider({ savesCards: false });
    for (const p of [await makeStore(), await makeRider(), await makeDriver()]) {
      const quote = await runtime.billing.quoteCardPayNow(p.subId);
      expect(await cardActionOf(p), p.family).toEqual({
        id: 'CARD', state: 'live', payNow: { amount: quote.amount, currencyCode: quote.currencyCode }, addCard: false, cardOnFile: null, testMode: false,
      });
    }
  });

  it('[staging] CARD_RAIL_SIMULATOR_LIVE: the simulator shows the card choice, labelled as a test — never to the store-review demo', async () => {
    const p = await makeStore();
    expect(await cardActionOf(p)).toEqual({ id: 'CARD', state: 'off' });
    process.env['CARD_RAIL_SIMULATOR_LIVE'] = '1';
    const quote = await runtime.billing.quoteCardPayNow(p.subId);
    expect(await cardActionOf(p)).toEqual({
      id: 'CARD', state: 'live', payNow: { amount: quote.amount, currencyCode: quote.currencyCode },
      addCard: true, cardOnFile: null, testMode: true, testModeLabel: SIMULATOR_PAGE.testModeLabel,
    });
    // iOS still follows its own switch.
    expect(await cardActionOf(p, { 'x-client-platform': 'ios' })).toEqual({ id: 'CARD', state: 'off' });
    const review = await makeReviewTenant();
    for (const demo of [await makeStore({ tenantId: review }), await makeRider({ tenantId: review })]) {
      expect(await cardActionOf(demo), demo.family).toEqual({ id: 'CARD', state: 'off' });
    }
  });

  it('[review S2] a REAL partner on a test server never sees or settles a simulator payment — even with the test switch on, even calling the routes directly', async () => {
    process.env['CARD_RAIL_SIMULATOR_LIVE'] = '1';
    for (const real of [await makeStore({ simulatorTest: false }), await makeRider({ simulatorTest: false }), await makeDriver({ simulatorTest: false })]) {
      expect(await cardActionOf(real), real.family).toEqual({ id: 'CARD', state: 'off' });
      for (const purpose of ['PAY_NOW', 'ENROLL'] as const) {
        const res = await startSession(real, purpose);
        expect(res.statusCode, `${real.family} ${purpose}: ${res.body}`).toBe(409);
        expect(res.json().error.code).toBe('PAY_ACTION_OFF');
      }
      expect(await app.prisma.cardSession.count({ where: { subscriptionId: real.subId } })).toBe(0);
      const m = await money(real.subId);
      expect(m.successes).toBe(0);
      expect(m.payments).toHaveLength(0);
    }
    // A listed TEST subscription on the same server still drives the whole loop.
    const test = await makeRider();
    expect((await cardActionOf(test))['state']).toBe('live');
  });

  it('saving cards switched off (CARD_RAIL_ENROLL): addCard false, ENROLL 409 ADD_CARD_OFF before any page, Pay now still opens', async () => {
    delete process.env['CARD_RAIL_ENROLL'];
    process.env['CARD_RAIL_SIMULATOR_LIVE'] = '1';
    const p = await makeRider();
    expect(await cardActionOf(p)).toMatchObject({ state: 'live', addCard: false, cardOnFile: null });
    const refused = await startSession(p, 'ENROLL');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('ADD_CARD_OFF');
    expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(0);
    expect((await startSession(p, 'PAY_NOW')).statusCode).toBe(201);
  });

  it('latestCardSession: the partner’s newest card session as its view (never the page address); a failure in plain words', async () => {
    const p = await makeRider();
    const payload = async () => (await partnerCall(p, 'GET', '/subscription')).json().data;
    expect((await payload()).latestCardSession).toBeNull();
    const declined = (await startSession(p, 'PAY_NOW')).json().data;
    expect((await payload()).latestCardSession).toMatchObject({ sessionId: declined.sessionId, purpose: 'PAY_NOW', status: 'OPEN', testMode: true });
    expect((await payload()).latestCardSession).not.toHaveProperty('hostedUrl');
    expect(pageState((await follow(await press(declined.hostedUrl, 'DECLINE'))).body)).toBe('FAILED');
    expect((await payload()).latestCardSession).toMatchObject({ sessionId: declined.sessionId, status: 'FAILED', failure: 'DECLINED' });
    expect((await partnerCall(p, 'GET', `${SESSIONS}/${declined.sessionId}`)).json().data).toMatchObject({ status: 'FAILED', failure: 'DECLINED' });
    process.env['CARD_RAIL_V2'] = '0';
    expect((await payload()).latestCardSession).toBeNull();
  });

  it('the card on file is the ACTIVE card as brand / last 4 / expiry / status — nothing else', async () => {
    const p = await makeRider();
    const opened = (await startSession(p, 'ENROLL')).json().data;
    expect(pageState((await follow(await press(opened.hostedUrl, 'APPROVE'))).body)).toBe('SUCCEEDED');
    railOverride = realProvider({ savesCards: true });
    const card = await cardActionOf(p);
    expect(card).toMatchObject({ state: 'live', addCard: true, cardOnFile: { brand: 'SIMULATED', last4: '4242', status: 'ACTIVE' } });
    expect(Object.keys(card['cardOnFile'] as object).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'last4', 'status']);
  });

  it('per platform: iOS off unless switched on; Android and web on unless switched off; an unknown platform only when all are on', async () => {
    railOverride = realProvider({ savesCards: false });
    const p = await makeStore();
    const state = async (platform: string) => (await cardActionOf(p, { 'x-client-platform': platform }))['state'];
    expect(await state('ios')).toBe('off');
    expect(await state('android')).toBe('live');
    expect(await state('web')).toBe('live');
    expect(await state('')).toBe('off');
    await app.prisma.platformConfig.create({ data: { key: CARD_CHECKOUT_PLATFORMS_KEY, value: { ios: true } } });
    resetCardCheckoutSwitchCache();
    expect(await state('ios')).toBe('live');
    expect(await state('')).toBe('live');
    await app.prisma.platformConfig.update({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY }, data: { value: { ios: true, web: false } } });
    resetCardCheckoutSwitchCache();
    expect(await state('web')).toBe('off');
    expect(await state('')).toBe('off');
  });

  it('[#1393, as MMG] never live while a payment of this fee is being confirmed, nor before the billing clock covers the subscription', async () => {
    railOverride = realProvider({ savesCards: false });
    const unmapped = await makeRider({ mapped: false });
    expect(await cardActionOf(unmapped)).toEqual({ id: 'CARD', state: 'off' });
    expect(await app.prisma.billingDunningClock.count({ where: { subscriptionId: unmapped.subId } })).toBe(0);

    const p = await makeRider();
    expect((await cardActionOf(p))['state']).toBe('live');
    const opened = (await startSession(p, 'PAY_NOW')).json().data;
    // A card page is open for this fee: no second way to pay is offered until it is settled.
    expect(await cardActionOf(p)).toEqual({ id: 'CARD', state: 'off' });
    railOverride = null; // the simulator's own page serves the button
    expect(pageState((await follow(await press(opened.hostedUrl, 'APPROVE'))).body)).toBe('SUCCEEDED');
    railOverride = realProvider({ savesCards: false });
    expect((await cardActionOf(p))['state']).toBe('live');
  });

  it('a subscription that cannot pay (billing stopped, waived): CARD off', async () => {
    railOverride = realProvider({ savesCards: false });
    const paused = await makeRider({ status: 'PAUSED' });
    expect(await cardActionOf(paused)).toEqual({ id: 'CARD', state: 'off' });
    const waived = await makeRider();
    await app.prisma.subscription.update({ where: { id: waived.subId }, data: { feeWaived: true } });
    expect(await cardActionOf(waived)).toEqual({ id: 'CARD', state: 'off' });
  });

  it('the payload never fails because the card rail cannot answer: CARD off, the rest of the Pay screen intact', async () => {
    const p = await makeStore();
    await partnerCall(p, 'GET', '/subscription'); // the first read assigns the store's Swift Number
    const healthy = await partnerCall(p, 'GET', '/subscription');
    const { rail } = runtime;
    Object.defineProperty(runtime, 'rail', { configurable: true, get() { throw new Error('the card rail configuration is broken'); } });
    try {
      const res = await partnerCall(p, 'GET', '/subscription');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.payActions).toEqual([{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }]);
      expect({ ...res.json().data, payActions: null }).toEqual({ ...healthy.json().data, payActions: null });
    } finally {
      Object.defineProperty(runtime, 'rail', { configurable: true, writable: true, value: rail });
    }
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

  it('[Sol #1404, as the MMG doors] the return is limited per SOURCE: one address rotating signed-in principals gets no extra allowance', async () => {
    const codes: number[] = [];
    for (let i = 0; i < CARD_RETURN_RATE.max + 1; i += 1) {
      // A fresh verified principal every time: the global key would give each its own bucket.
      const token = app.jwt.sign({ userId: `rotating-${RUN}-${i}`, role: 'CUSTOMER', jti: nanoid(8) });
      codes.push((await app.inject({ method: 'GET', url: `${RETURN}?session=x&state=y`, remoteAddress: '203.0.113.78', headers: { authorization: `Bearer ${token}` } })).statusCode);
    }
    expect(codes.slice(0, CARD_RETURN_RATE.max).every((c) => c === 200)).toBe(true);
    expect(codes[CARD_RETURN_RATE.max]).toBe(429);
  });
});

describe('[review S3 · S4] the return page: two ways back, and a time limit on the provider', () => {
  it('every state shows "Back to the Swift app" AND "Continue on the web" (the web\'s neutral weekly-fee route)', () => {
    const before = process.env['APP_PUBLIC_URL'];
    process.env['APP_PUBLIC_URL'] = 'https://web.example.test/';
    try {
      expect(cardWebFeeUrl()).toBe('https://web.example.test/weekly-fee');
      for (const state of CARD_RETURN_PAGES) {
        const html = returnPageHtml(state);
        expect(html, state).toContain(`href="${CARD_APP_RETURN_LINK}" target="_top">Back to the Swift app</a>`);
        expect(html, state).toContain('href="https://web.example.test/weekly-fee" target="_top">Continue on the web</a>');
      }
      process.env['APP_PUBLIC_URL'] = 'not a url';
      expect(cardWebFeeUrl()).toBe('https://swiftgy.com/weekly-fee');
    } finally {
      if (before === undefined) delete process.env['APP_PUBLIC_URL']; else process.env['APP_PUBLIC_URL'] = before;
    }
  });

  it('a provider that answers slowly: the page says PENDING within the limit, and the late answer still books the week once', async () => {
    const slowApp = Fastify({ logger: false });
    registerErrorHandler(slowApp);
    await slowApp.register(prismaPlugin);
    await slowApp.register(redisPlugin);
    await slowApp.register(authPlugin);
    await slowApp.register(socketPlugin);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowService = Object.create(runtime.service) as CardRailService;
    slowService.confirm = async (id, opts) => { await gate; return runtime.service.confirm(id, opts); };
    slowApp.decorate(CARD_RAIL_RUNTIME_DECORATION, { ...runtime, service: slowService });
    await slowApp.register(cardRailPublicRoutes, { prefix: '/api/v1/billing/card', confirmWaitMs: 50 });
    await slowApp.ready();
    try {
      const p = await makeStore();
      const session = (await startSession(p, 'PAY_NOW')).json().data;
      const location = await press(session.hostedUrl, 'APPROVE');
      const started = Date.now();
      const res = await slowApp.inject({ method: 'GET', url: location });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(pageState(res.body)).toBe('PENDING');
      expect((await money(p.subId)).successes).toBe(0);
      release();
      // The ledger commit is visible before confirm stores its final session verdict.
      // Wait for both durable results within the same bounded polling loop.
      for (let i = 0; i < 50; i += 1) {
        const settled = await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } });
        if ((await money(p.subId)).successes === 1 && settled.status === 'SUCCEEDED') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect((await money(p.subId)).successes).toBe(1);
      expect((await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status).toBe('SUCCEEDED');
    } finally {
      release();
      await slowApp.close();
    }
  });
});

describe('the provider is never named to a partner', () => {
  it('no page Swift serves and no card-route answer names the card provider', async () => {
    for (const state of CARD_RETURN_PAGES) expect(returnPageHtml(state), state).not.toMatch(/powertranz|ptranz/i);
    const p = await makeRider();
    const session = (await startSession(p, 'PAY_NOW')).json().data;
    const bodies = [
      (await app.inject({ method: 'GET', url: session.hostedUrl })).body,
      (await app.inject({ method: 'GET', url: '/api/v1/billing/card/simulator/sim_000000000000000000000000' })).body,
      (await follow(await press(session.hostedUrl, 'DECLINE'))).body,
      (await partnerCall(p, 'GET', `${SESSIONS}/${session.sessionId}`)).body,
      (await partnerCall(p, 'GET', '/subscription/cards')).body,
      (await startSession(p, 'PAY_NOW', { payload: { purpose: 'PAY_NOW', amount: 1 } })).body,
      (await startSession(p, 'ENROLL', { payload: { purpose: 'ENROLL' } })).body,
      (await partnerCall(p, 'GET', `${SESSIONS}/nosuchsession`)).body,
    ];
    for (const body of bodies) expect(body).not.toMatch(/powertranz|ptranz/i);
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
