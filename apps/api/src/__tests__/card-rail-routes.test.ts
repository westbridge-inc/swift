import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import { Writable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { CardSession, SubscriptionStatus, UserRole } from '@prisma/client';
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
import { resolveConfirmationInTx, ACTIVE_CONFIRMATION_STATES, hasConfirmationInTx, readDunningClock } from '../modules/billing/dunning-clock';
import { readFeePaymentDecision } from '../modules/billing/fee-payment-authority';
import { confirmationReviewQueue, resolveFinanceConfirmation } from '../modules/billing/confirmation-finance';
import { CARD_ON_FILE_CONSENT_VERSION, CARD_SANDBOX_TEST_LABEL, CardRailService } from '../modules/billing/card-rail.service';
import { CARD_CHECKOUT_PLATFORMS_KEY, resetCardCheckoutSwitchCache } from '../modules/billing/card-pay-action';
import {
  CARD_APP_RETURN_LINK,
  CARD_RAIL_RUNTIME_DECORATION,
  CARD_RETURN_BODY_LIMIT,
  CARD_RETURN_RATE,
  CARD_RETURN_PAGES,
  CARD_SESSION_START_RATE,
  CARD_FRAME_SANDBOX,
  HOSTED_CARD_PAGE_CSP,
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
import { POWERTRANZ_SANDBOX_ROOT, PowerTranzCardRailProvider, readCompletion } from '../providers/card/powertranz-provider';
import type { CardSessionOutcome, CompletionClaim } from '../providers/card/card-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { deleteRunKeys, runKeyPrefix } from './helpers/card-sim-keys';
import { injectWithApproval } from './helpers/admin-approval';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

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
    process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'] = simulatorTestSubs.join(',');
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
    // Its own live setup (the label the screen shows follows it); the routes never ask it for a page here.
    binding: { provider: 'realcards', environment: 'live', account: ACCOUNT },
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
  delete process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'];
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
      const sessionStatus = async () => (await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status;
      // The week is booked, then the session row is marked: wait (bounded) for both.
      for (let i = 0; i < 50 && ((await money(p.subId)).successes === 0 || (await sessionStatus()) !== 'SUCCEEDED'); i += 1) await new Promise((r) => setTimeout(r, 100));
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

// ---------------------------------------------------------------------------
// [PT-4] The real card provider through HTTP: a second app whose card rail is
// the PowerTranz provider, talking to a fake gateway that answers in the
// guide's documented shapes (synthetic values). The partner, the hosted page,
// the browser's 3-D Secure result and the completion — end to end.
// ---------------------------------------------------------------------------

describe('[PT-4] real cards through HTTP: Swift\'s hosted page, the bank\'s check, one completion', () => {
  const ORIGIN = 'https://api.example.test';
  const PTZ_PREFIX = `ptz:r${RUN}:`;
  let ptz: FastifyInstance;
  let real: PowerTranzCardRailProvider;
  type Answer = { status: number; body: unknown } | 'network';
  const calls: Array<{ path: string; body: string }> = [];
  let sale: (body: Record<string, unknown>) => Answer;
  let payment: (held: { txnId: string; orderId: string }) => Answer | Promise<Answer>;
  let voidAnswer: (body: Record<string, unknown>) => Answer;
  let refundAnswer: (body: Record<string, unknown>) => Answer;

  const fakeFetch = (async (url: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ path, body });
    let answer: Answer;
    if (path === '/api/spi/sale') answer = sale(JSON.parse(body) as Record<string, unknown>);
    else if (path === '/api/spi/payment') {
      const held = (await redis.keys(`${PTZ_PREFIX}s:*`));
      let txnId = '';
      let orderId = '';
      for (const k of held) {
        if ((await redis.hget(k, 'spiToken')) !== JSON.parse(body)) continue;
        txnId = (await redis.hget(k, 'txnId')) ?? '';
        orderId = (await redis.hget(k, 'orderId')) ?? '';
      }
      answer = await payment({ txnId, orderId });
    } else if (path === '/api/void') answer = voidAnswer(JSON.parse(body) as Record<string, unknown>);
    else if (path === '/api/refund') answer = refundAnswer(JSON.parse(body) as Record<string, unknown>);
    else answer = { status: 404, body: 'not found' };
    if (answer === 'network') throw new TypeError('fetch failed');
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;

  const preprocess = (req: Record<string, unknown>): Answer => ({
    status: 200,
    body: {
      TransactionType: 2, Approved: false, TransactionIdentifier: req['TransactionIdentifier'], IsoResponseCode: 'SP4', OrderIdentifier: req['OrderIdentifier'],
      RedirectData: '<form id="f" method="post" action="https://hpp.example.test/pay"><input type="hidden" name="t" value="synthetic"></form><script>document.getElementById("f").submit()</script>',
      SpiToken: `spi-${nanoid(12)}`,
    },
  });
  const approve = (fields: Record<string, unknown> = {}) => (held: { txnId: string; orderId: string }): Answer => ({
    status: 200,
    body: {
      TransactionType: 2, Approved: true, AuthorizationCode: '123456', TransactionIdentifier: held.txnId, OrderIdentifier: held.orderId, TotalAmount: 2100, CurrencyCode: '328', RRN: '000000000001', IsoResponseCode: '00',
      RiskManagement: { ThreeDSecure: { Eci: '05', AuthenticationStatus: 'Y', ResponseCode: '3D0' } }, // the completion's OWN 3-D Secure proof (sec. 6)
      ...fields,
    },
  });
  /** sec. 7.6 / 7.5: an approved void (type 4) or refund (type 5) of the named transaction, as the guide's samples answer. */
  const adjusted = (b: Record<string, unknown>): Answer => ({
    status: 200,
    body: b['Refund'] === true
      ? { OriginalTrxnIdentifier: b['TransactionIdentifier'], TransactionType: 5, Approved: true, TransactionIdentifier: nanoid(8), TotalAmount: b['TotalAmount'], CurrencyCode: b['CurrencyCode'], IsoResponseCode: '00', ResponseMessage: 'Transaction is approved' }
      : { OriginalTrxnIdentifier: b['TransactionIdentifier'], TransactionType: 4, Approved: true, TransactionIdentifier: b['TransactionIdentifier'], TotalAmount: 2100, CurrencyCode: '328', IsoResponseCode: '00', ResponseMessage: 'Transaction is approved' },
  });

  const call = (p: Partner, method: 'GET' | 'POST' | 'DELETE', path: string, opts: { payload?: unknown; headers?: Record<string, string> } = {}) =>
    ptz.inject({ method, url: `/api/v1/${p.family}${path}`, headers: headersOf(p, opts.headers), ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}) });
  const open = (p: Partner, purpose: 'PAY_NOW' | 'ENROLL' = 'PAY_NOW') =>
    call(p, 'POST', SESSIONS, { payload: { purpose, ...(purpose === 'ENROLL' ? { consentVersion: CARD_ON_FILE_CONSENT_VERSION } : {}) }, headers: { 'idempotency-key': key() } });
  const pathOf = (url: string) => url.replace(ORIGIN, '');
  /** The MerchantResponseUrl Swift sent with the Sale (sec. 5.1): where the bank's frame posts its result. */
  const merchantResponsePath = () => {
    const last = [...calls].reverse().find((c) => c.path === '/api/spi/sale')!;
    const ext = (JSON.parse(last.body) as { ExtendedData: { MerchantResponseUrl: string } }).ExtendedData;
    return pathOf(ext.MerchantResponseUrl);
  };
  /** The page's held facts, as the bank's frame would echo them. */
  async function heldOf(sessionId: string) {
    const row = await app.prisma.cardSession.findUniqueOrThrow({ where: { id: sessionId } });
    return redis.hgetall(`${PTZ_PREFIX}s:${row.providerSessionRef}`);
  }
  /** The bank's frame posts the authentication result "as Json" (Appendix 2), as a form can: text/plain. */
  async function bankFramePosts(sessionId: string, status: string, extra: Record<string, unknown> = {}) {
    const held = await heldOf(sessionId);
    const result = {
      TransactionType: 2, Approved: false, TransactionIdentifier: held['txnId'], IsoResponseCode: '3D0', OrderIdentifier: held['orderId'], SpiToken: held['spiToken'],
      CardBrand: 'Visa', RiskManagement: { ThreeDSecure: { Eci: '05', AuthenticationStatus: status, ResponseCode: '3D0' } },
      BillingAddress: { EmailAddress: 'cardholder@example.test' }, ...extra,
    };
    return ptz.inject({ method: 'POST', url: merchantResponsePath(), headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(result) });
  }
  const completions = () => calls.filter((c) => c.path === '/api/spi/payment').length;
  const sent = (path: '/api/void' | '/api/refund') => calls.filter((c) => c.path === path).map((c) => JSON.parse(c.body) as Record<string, unknown>);
  const rowOf = (sessionId: string) => app.prisma.cardSession.findUniqueOrThrow({ where: { id: sessionId } });
  const serviceOf = () => (ptz as unknown as Record<string, CardRailRuntime>)[CARD_RAIL_RUNTIME_DECORATION]!.service;
  const confirmationOf = (sessionId: string) => app.prisma.paymentConfirmationHold.findFirst({ where: { cardSessionId: sessionId } });
  async function makeFinance() {
    return makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN');
  }
  /** Finance's decision on a HELD card payment: C4 — the request, a SECOND admin's approval, the request again. */
  const resolve = (admin: { token: string }, sessionId: string, payload: Record<string, unknown>) => injectWithApproval(ptz, {
    method: 'POST', url: `/api/v1/admin/billing/card-sessions/${sessionId}/resolve`,
    headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
    payload: payload as never,
  });
  /** A Pay now whose approval Swift could not book and whose void the gateway refused: HELD for a person. */
  async function heldPayment(p: Partner) {
    payment = approve({ RiskManagement: undefined });
    voidAnswer = () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', ResponseMessage: 'Invalid transaction' } });
    const session = (await open(p)).json().data;
    expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('PENDING');
    const row = await rowOf(session.sessionId);
    expect(row).toMatchObject({ status: 'HELD', failureCode: 'APPROVED_UNPROVEN', providerVoidState: 'FAILED' });
    payment = approve();
    voidAnswer = adjusted;
    return { sessionId: session.sessionId as string, txnId: row.providerTransactionRef! };
  }

  async function verifiedHeldPayment(p: Partner) {
    const billing = (serviceOf() as unknown as { billing: BillingService }).billing;
    const settle = billing.settleHostedCardPayment.bind(billing);
    billing.settleHostedCardPayment = async () => ({ outcome: 'held', failureCode: 'WALLET_CURRENCY_MISMATCH' });
    try {
      payment = approve();
      const session = (await open(p)).json().data;
      await bankFramePosts(session.sessionId, 'Y');
      const row = await rowOf(session.sessionId);
      expect(row.status).toBe('HELD');
      expect(row.completionEvidence).toMatchObject({ Approved: true, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y' } } });
      expect((await money(p.subId)).successes).toBe(0);
      return { sessionId: session.sessionId as string, txnId: row.providerTransactionRef! };
    } finally { billing.settleHostedCardPayment = settle; }
  }

  beforeAll(async () => {
    sale = preprocess;
    payment = approve();
    voidAnswer = adjusted;
    refundAnswer = adjusted;
    ptz = Fastify({ logger: false });
    registerErrorHandler(ptz);
    registerEmptyJsonBodyParser(ptz);
    await ptz.register(prismaPlugin);
    await ptz.register(redisPlugin);
    await ptz.register(authPlugin);
    await ptz.register(socketPlugin);
    await ptz.register(rateLimit, { keyGenerator: rateLimitKey((token) => ptz.jwt.verify(token)), max: 10_000, timeWindow: '1 minute' });
    real = new PowerTranzCardRailProvider(redis, {
      account: `pt4r-${RUN}`, environment: 'sandbox', apiRoot: POWERTRANZ_SANDBOX_ROOT, powerTranzId: 'TESTID01', password: 'not-a-real-password',
      pageSet: 'PTZ/SwiftTest', pageName: 'WeeklyFee', publicBaseUrl: ORIGIN,
    }, { fetch: fakeFetch, keyPrefix: PTZ_PREFIX });
    const notifications = new NotificationService(ptz.prisma, ptz.io);
    const billing = new BillingService(ptz.prisma, notifications, new SandboxPaymentProvider(), undefined, () => real);
    ptz.decorate(CARD_RAIL_RUNTIME_DECORATION, { service: new CardRailService(ptz.prisma, notifications, billing, () => real, { returnUrlBase: ORIGIN }), billing, rail: () => real });
    await ptz.register(vendorRoutes, { prefix: '/api/v1/vendor' });
    await ptz.register(riderRoutes, { prefix: '/api/v1/rider' });
    await ptz.register(driverRoutes, { prefix: '/api/v1/driver' });
    await ptz.register(adminRoutes, { prefix: '/api/v1/admin' });
    await ptz.register(cardRailPublicRoutes, { prefix: '/api/v1/billing/card' });
    await ptz.ready();
  });

  afterEach(() => {
    sale = preprocess;
    payment = approve();
    voidAnswer = adjusted;
    refundAnswer = adjusted;
  });

  afterAll(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${PTZ_PREFIX}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys.filter((k) => k.startsWith(PTZ_PREFIX)));
    } while (cursor !== '0');
    await ptz.close();
  });

  it('Pay now: Swift\'s page frames the bank\'s form; the bank\'s check passes; ONE completion books the week ONCE', async () => {
    sale = preprocess; payment = approve();
    const p = await makeStore();
    const cardAction = (await call(p, 'GET', '/subscription')).json().data.payActions[1];
    expect(cardAction).toMatchObject({ id: 'CARD', state: 'live', addCard: false, testMode: true, testModeLabel: CARD_SANDBOX_TEST_LABEL });
    const opened = await open(p);
    expect(opened.statusCode, opened.body).toBe(201);
    const session = opened.json().data;
    expect(session).toMatchObject({ purpose: 'PAY_NOW', status: 'OPEN', testMode: true, testModeLabel: CARD_SANDBOX_TEST_LABEL });
    expect(session.hostedUrl).toMatch(/^https:\/\/api\.example\.test\/api\/v1\/billing\/card\/pay\/ptz_[0-9a-f]{24}$/);

    const pageRes = await ptz.inject({ method: 'GET', url: pathOf(session.hostedUrl) });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.headers['content-security-policy']).toBe(HOSTED_CARD_PAGE_CSP);
    // [Review S3] Scripts, styles and form posts reach only the card provider's own hosts; the frame is sandboxed.
    const csp = Object.fromEntries(HOSTED_CARD_PAGE_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]));
    expect(csp).toMatchObject({
      'default-src': "'none'", 'script-src': "'unsafe-inline' https://*.ptranz.com", 'form-action': 'https://*.ptranz.com',
      'connect-src': "'none'", 'frame-ancestors': "'none'", 'base-uri': "'none'", 'object-src': "'none'",
    });
    expect(pageRes.body).toContain(`sandbox="${CARD_FRAME_SANDBOX}"`);
    expect(CARD_FRAME_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
    expect(pageRes.headers['cache-control']).toBe('no-store');
    expect(pageRes.headers['referrer-policy']).toBe('no-referrer');
    expect(pageRes.body).toContain('<iframe class="card"');
    expect(pageRes.body).toContain('srcdoc="&lt;form id=&quot;f&quot;');
    expect(pageRes.body).toContain(CARD_SANDBOX_TEST_LABEL.replace("'", '&#39;'));
    expect(pageRes.body).toContain('<h1>Pay GY$2,100 by card</h1>');
    // Swift's own words never name the provider; no card field is Swift's.
    const own = pageRes.body.replace(/srcdoc="[^"]*"/, '');
    expect(own).not.toMatch(/powertranz|ptranz/i);
    expect(own).not.toMatch(/<input|<select|<textarea/i);
    expect(completions()).toBe(0);

    const back = await bankFramePosts(session.sessionId, 'Y');
    expect(back.statusCode).toBe(200);
    expect(pageState(back.body)).toBe('SUCCEEDED');
    expect(back.body).not.toMatch(/powertranz|ptranz/i);
    expect(completions()).toBe(1);
    const m = await money(p.subId);
    expect(m.successes).toBe(1);
    const captured = m.payments.filter((x) => x.status === 'CAPTURED');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.externalRef).toBe((await heldOf(session.sessionId))['txnId']);
    // The same post again (a reload of the frame): nothing more, no second completion.
    expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('SUCCEEDED');
    expect(completions()).toBe(1);
    expect((await money(p.subId)).successes).toBe(1);
    expect((await call(p, 'GET', `${SESSIONS}/${session.sessionId}`)).json().data).toMatchObject({ status: 'SUCCEEDED', settlement: 'advanced' });
    // The page is finished: no bank form is served again.
    const after = await ptz.inject({ method: 'GET', url: pathOf(session.hostedUrl) });
    expect(after.body).not.toContain('<iframe');
    expect(after.body).toContain('This card page has ended');
  });

  it('the bank\'s check fails (N): no completion, nothing booked, a plain NOT_AUTHENTICATED — and the card choice comes back at once', async () => {
    const p = await makeRider();
    const session = (await open(p)).json().data;
    expect((await call(p, 'GET', '/subscription')).json().data.payActions[1]).toEqual({ id: 'CARD', state: 'off' }); // a page is open
    const before = completions();
    expect(pageState((await bankFramePosts(session.sessionId, 'N')).body)).toBe('FAILED');
    expect(completions()).toBe(before);
    expect((await money(p.subId)).successes).toBe(0);
    expect((await call(p, 'GET', `${SESSIONS}/${session.sessionId}`)).json().data).toMatchObject({ status: 'FAILED', failure: 'NOT_AUTHENTICATED' });
    expect((await call(p, 'GET', '/subscription')).json().data.payActions[1]).toMatchObject({ state: 'live' });
  });

  it('the browser claims approval, the bank declines the completion: nothing booked [C5]', async () => {
    payment = () => ({ status: 200, body: { Approved: false, IsoResponseCode: '05', ResponseMessage: 'Do not honor' } });
    const p = await makeRider();
    const session = (await open(p)).json().data;
    expect(pageState((await bankFramePosts(session.sessionId, 'Y', { Approved: true, IsoResponseCode: '00' })).body)).toBe('FAILED');
    expect((await money(p.subId)).successes).toBe(0);
    expect((await call(p, 'GET', `${SESSIONS}/${session.sessionId}`)).json().data).toMatchObject({ status: 'FAILED', failure: 'DECLINED' });
  });

  it('the page cannot be made (the gateway refuses the Sale): 502, the session closes, the payment confirmation is resolved — the partner can pay at once', async () => {
    sale = () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', ResponseMessage: 'Invalid transaction', Errors: [{ Code: '757', Message: 'Hosted page not found' }] } });
    const p = await makeRider();
    const refused = await open(p);
    expect(refused.statusCode, refused.body).toBe(502);
    expect(refused.json().error.code).toBe('CARD_SESSION_UNAVAILABLE');
    expect(refused.body).not.toMatch(/powertranz|ptranz/i);
    const [row] = await app.prisma.cardSession.findMany({ where: { subscriptionId: p.subId } });
    expect(row).toMatchObject({ status: 'CANCELLED', failureCode: 'PROVIDER_PAGE_UNAVAILABLE' });
    const hold = await app.prisma.paymentConfirmationHold.findFirst({ where: { cardSessionId: row!.id } });
    expect(hold?.status).toBe('PROVEN_NO_EFFECT');
    expect((await call(p, 'GET', '/subscription')).json().data.payActions[1]).toMatchObject({ state: 'live' });
    sale = preprocess;
    expect((await open(p)).statusCode).toBe(201);
  });

  it('[review S2-2] the completion\'s answer is lost: the transaction is VOIDED at once, once; the session closes only after the void is confirmed; never a second completion', async () => {
    payment = () => 'network';
    const p = await makeRider();
    const session = (await open(p)).json().data;
    const txnId = (await heldOf(session.sessionId))['txnId'];
    expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('FAILED');
    expect(completions()).toBeGreaterThan(0);
    const completed = completions();
    expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toEqual([{ TransactionIdentifier: txnId }]);
    expect(await rowOf(session.sessionId)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED', providerTransactionRef: txnId });
    expect((await confirmationOf(session.sessionId))?.status).toBe('PROVEN_UNPAID');
    // Asked again, inside and past the window: no second completion, no second void.
    const row = await rowOf(session.sessionId);
    await serviceOf().confirm(session.sessionId);
    await serviceOf().confirm(session.sessionId, { now: new Date(row.expiresAt.getTime() + 60_000) });
    expect(completions()).toBe(completed);
    expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
    expect((await money(p.subId)).successes).toBe(0);
    expect((await call(p, 'GET', '/subscription')).json().data.payActions[1]).toMatchObject({ state: 'live' });
  });

  it('[review S2-2] the void\'s own answer is lost too: HELD at once, admins paged with the reason and the provider\'s transaction; never voided twice', async () => {
    payment = () => 'network';
    voidAnswer = () => 'network';
    const finance = await makeFinance();
    const p = await makeRider();
    const session = (await open(p)).json().data;
    const txnId = (await heldOf(session.sessionId))['txnId']!;
    expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('PENDING');
    expect(await rowOf(session.sessionId)).toMatchObject({ status: 'HELD', failureCode: 'APPROVED_UNPROVEN', providerVoidState: 'UNKNOWN', providerTransactionRef: txnId });
    const [page] = await app.prisma.notification.findMany({ where: { userId: finance.userId, dedupeKey: `card-session-held:${session.sessionId}` } });
    expect(page?.body).toContain('APPROVED_UNPROVEN');
    expect(page?.body).toContain(txnId);
    expect(page?.data).toMatchObject({ failureCode: 'APPROVED_UNPROVEN', providerTransactionRef: txnId, sessionId: session.sessionId });
    voidAnswer = adjusted;
    const row = await rowOf(session.sessionId);
    await serviceOf().confirm(session.sessionId, { now: new Date(row.expiresAt.getTime() + 60_000) });
    await serviceOf().sweepSessions(new Date(row.expiresAt.getTime() + 3_600_000));
    expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
    expect((await rowOf(session.sessionId)).status).toBe('HELD');
    expect((await money(p.subId)).successes).toBe(0);
  });

  it('[review S2-2] a void claimed by a server that then stopped: never sent again; past the wait it is HELD for a person', async () => {
    payment = approve({ RiskManagement: undefined });
    const p = await makeRider();
    const session = (await open(p)).json().data;
    const claimedAt = new Date();
    // The claim a stopped server leaves behind (its void call never answered).
    await app.prisma.cardSession.update({ where: { id: session.sessionId }, data: { providerVoidState: 'SENDING', providerVoidAt: claimedAt, providerTransactionRef: (await heldOf(session.sessionId))['txnId'] } });
    const before = sent('/api/void').length;
    expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('PENDING');
    expect((await rowOf(session.sessionId)).status).toBe('OPEN');
    await serviceOf().confirm(session.sessionId, { now: new Date(claimedAt.getTime() + 5 * 60_000) });
    expect(await rowOf(session.sessionId)).toMatchObject({ status: 'HELD', failureCode: 'APPROVED_UNPROVEN', providerVoidState: 'UNKNOWN' });
    expect(sent('/api/void').length).toBe(before);
    expect((await money(p.subId)).successes).toBe(0);
  });

  it('[review S2-2] the gateway refuses the void: HELD, admins paged; the claim is durable (the database refuses a second claim)', async () => {
    const p = await makeRider();
    const { sessionId, txnId } = await heldPayment(p);
    expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
    await expect(app.prisma.cardSession.update({ where: { id: sessionId }, data: { providerVoidState: 'SENDING' } })).rejects.toThrow();
    await expect(app.prisma.cardSession.update({ where: { id: sessionId }, data: { providerTransactionRef: 'another' } })).rejects.toThrow();
    expect((await money(p.subId)).successes).toBe(0);
  });

  it('[3DS · forged return] the browser claims 3-D Secure success AND approval; PowerTranz\'s own answer is not authenticated: nothing is booked, nothing is paid', async () => {
    // The forged post says everything a thief would want; PowerTranz, server to server, says the cardholder was NOT authenticated.
    payment = approve({ RiskManagement: { ThreeDSecure: { Eci: '07', AuthenticationStatus: 'N', ResponseCode: '3D0' } } });
    const p = await makeStore();
    const periodEndBefore = (await money(p.subId)).sub.currentPeriodEnd.getTime();
    const session = (await open(p)).json().data;
    const back = await bankFramePosts(session.sessionId, 'Y', {
      Approved: true, IsoResponseCode: '00', AuthorizationCode: '999999', ResponseMessage: 'Transaction is approved.',
      RiskManagement: { ThreeDSecure: { Eci: '05', AuthenticationStatus: 'Y', Cavv: 'forged', ResponseCode: '3D0' } },
    });
    expect(pageState(back.body)).not.toBe('SUCCEEDED');
    const m = await money(p.subId);
    expect(m.successes).toBe(0);
    expect(m.payments.filter((x) => x.status === 'CAPTURED')).toHaveLength(0);
    expect(m.sub.currentPeriodEnd.getTime()).toBe(periodEndBefore);
    expect((await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status).not.toBe('SUCCEEDED');
    expect((await call(p, 'GET', `${SESSIONS}/${session.sessionId}`)).json().data.status).not.toBe('SUCCEEDED');
    // [Review S2-2] The approval PowerTranz did give is voided at once — nothing is left taken.
    const txnId = (await heldOf(session.sessionId))['txnId'];
    expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
    expect(await rowOf(session.sessionId)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED' });
  });

  it('[3DS · forged return] PowerTranz\'s own answer carries no 3-D Secure proof at all: never booked — the approval is voided at once', async () => {
    payment = approve({ RiskManagement: undefined });
    const p = await makeStore(); // the approval's amount is this store's fee: only the missing proof can stop it
    const session = (await open(p)).json().data;
    expect(pageState((await bankFramePosts(session.sessionId, 'Y', { Approved: true, IsoResponseCode: '00' })).body)).toBe('FAILED');
    expect((await money(p.subId)).successes).toBe(0);
    const txnId = (await heldOf(session.sessionId))['txnId'];
    expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
    expect(await rowOf(session.sessionId)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerTransactionRef: txnId });
  });

  for (const [what, fields] of [
    ['names no transaction', { TransactionIdentifier: undefined }],
    ['names another order', { OrderIdentifier: 'SWIFT-cs_someone_else' }],
    ['is not a Sale', { TransactionType: 1 }],
  ] as const) {
    it(`[review S3] an approval that ${what}: never booked — voided`, async () => {
      payment = (held) => approve({ ...fields })(held);
      const p = await makeStore();
      const session = (await open(p)).json().data;
      expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('FAILED');
      expect((await money(p.subId)).successes).toBe(0);
      expect(await rowOf(session.sessionId)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED' });
    });
  }

  it('[review S4] a session asked again and again with the same answer adds ONE evidence row, not one per sweep', async () => {
    const p = await makeStore();
    const session = (await open(p)).json().data;
    const row = await rowOf(session.sessionId);
    await redis.del(`${PTZ_PREFIX}s:${row.providerSessionRef}`); // the page's record is gone: every answer is the same "unknown"
    for (const minutes of [1, 11, 21, 31]) await serviceOf().confirm(session.sessionId, { now: new Date(row.expiresAt.getTime() + minutes * 60_000) });
    expect((await rowOf(session.sessionId)).status).toBe('UNKNOWN');
    expect(await app.prisma.cardObservation.count({ where: { sessionId: session.sessionId, source: 'CONFIRM' } })).toBe(1);
    expect((await money(p.subId)).successes).toBe(0);
  });

  it('[3DS · forged return] a return posted with no session state, or another session\'s, changes nothing and asks PowerTranz nothing', async () => {
    const p = await makeRider();
    const session = (await open(p)).json().data;
    const held = await heldOf(session.sessionId);
    const claim = JSON.stringify({ Approved: true, IsoResponseCode: '00', SpiToken: held['spiToken'], TransactionIdentifier: held['txnId'], RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y', Eci: '05', ResponseCode: '3D0' } } });
    const before = completions();
    const wrongState = merchantResponsePath().replace(/state=[^&]+/, `state=${'Q'.repeat(43)}`);
    for (const url of [wrongState, '/api/v1/billing/card/return', `/api/v1/billing/card/return?session=${session.sessionId}`]) {
      const res = await ptz.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain' }, payload: claim });
      expect(pageState(res.body), url).toBe('UNKNOWN');
    }
    expect(completions()).toBe(before);
    expect((await money(p.subId)).successes).toBe(0);
    expect((await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status).toBe('OPEN');
  });

  it('a completion for another amount: nothing booked — voided at once', async () => {
    payment = approve({ TotalAmount: 1 });
    const p = await makeStore();
    const session = (await open(p)).json().data;
    expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('FAILED');
    expect((await money(p.subId)).successes).toBe(0);
    expect(await rowOf(session.sessionId)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED' });
  });

  it('[review S2-1] the provider\'s TEST system never serves a real partner: CARD off, 409 PAY_ACTION_OFF, nothing opened', async () => {
    for (const real of [await makeStore({ simulatorTest: false }), await makeRider({ simulatorTest: false }), await makeDriver({ simulatorTest: false })]) {
      expect((await call(real, 'GET', '/subscription')).json().data.payActions[1], real.family).toEqual({ id: 'CARD', state: 'off' });
      const res = await open(real);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('PAY_ACTION_OFF');
      expect(await app.prisma.cardSession.count({ where: { subscriptionId: real.subId } })).toBe(0);
    }
  });

  it('[review S2-1] a sandbox approval for a subscription no longer listed as a test: HELD, never a paid week', async () => {
    const p = await makeStore();
    const session = (await open(p)).json().data;
    const listed = process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'];
    process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'] = (listed ?? '').split(',').filter((id) => id !== p.subId).join(',');
    try {
      expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('PENDING');
    } finally {
      process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'] = listed;
    }
    const txnId = (await heldOf(session.sessionId))['txnId']!;
    expect(await rowOf(session.sessionId)).toMatchObject({ status: 'HELD', failureCode: 'TEST_SYSTEM_FOR_A_REAL_PARTNER', providerTransactionRef: txnId });
    const m = await money(p.subId);
    expect(m.successes).toBe(0);
    expect(m.payments.filter((x) => x.status === 'CAPTURED')).toHaveLength(0);
    // Finance can never book it either, while the subscription is not a listed test.
    process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'] = (listed ?? '').split(',').filter((id) => id !== p.subId).join(',');
    try {
      const finance = await makeFinance();
      const book = await resolve(finance, session.sessionId, { action: 'BOOK', providerReference: txnId, amount: 2100 });
      expect(book.json().error?.code, book.body).toBe('TEST_SYSTEM_NEVER_BOOKS');
    } finally {
      process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'] = listed;
    }
    expect((await money(p.subId)).successes).toBe(0);
  });

  describe('[CARDS] delayed completion money fences', () => {
    for (const situation of ['finance during request', 'expiry sweep during request', 'approval after finance closure', 'approval after finance closure with refused void'] as const) {
      it(situation, async () => {
        const finance = await makeFinance();
        const p = await makeStore();
        const session = (await open(p)).json().data;
        const row = await rowOf(session.sessionId);
        const txnId = (await heldOf(session.sessionId))['txnId']!;
        const before = completions();
        if (situation.endsWith('refused void')) voidAnswer = () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12' } });
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const started = new Promise<void>((r) => { entered = r; });
        payment = async (held) => { entered(); await gate; return approve()(held); };
        // Start the real browser-return path; stop only the fake gateway answer.
        const returning = bankFramePosts(session.sessionId, 'Y');
        await started;
        try {
          if (situation === 'expiry sweep during request') {
            await serviceOf().sweepSessions(new Date(row.expiresAt.getTime() + 1));
            expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
          } else {
            const later = situation.startsWith('approval after finance closure') ? new Date(Date.now() + 120_000) : new Date();
            const [hold] = (await confirmationReviewQueue(app.prisma, row.tenantId, later)).filter((r) => r.sourceId === row.id);
            const input = {
              id: hold!.id, tenantId: row.tenantId, actorId: finance.userId, sourceId: row.id,
              epoch: hold!.epoch, clockVersion: hold!.clockVersion, decision: 'UNPAID' as const, evidenceReference: 'synthetic-portal-check',
            };
            if (situation === 'finance during request') {
              await expect(resolveFinanceConfirmation(app.prisma, input, async () => undefined, later)).rejects.toMatchObject({ code: 'CARD_COMPLETION_IN_FLIGHT' });
            } else {
              // Even after the wait an uncertain completion cannot reopen collection.
              await expect(resolveFinanceConfirmation(app.prisma, input, async () => undefined, later)).rejects.toMatchObject({ code: 'CARD_SESSION_RESOLVE_REQUIRED' });
              // Reproduce a closure persisted by the previous implementation.
              await app.prisma.$transaction(async (tx) => {
                await tx.cardSession.update({ where: { id: row.id }, data: { status: 'FAILED', failureCode: 'FINANCE_CONFIRMED_UNPAID', confirmedAt: new Date() } });
                await resolveConfirmationInTx(tx, row.subscriptionId, { cardSessionId: row.id }, 'PROVEN_UNPAID', { actor: finance.userId, reference: 'legacy-closure-fixture' });
              });
            }
          }
        } finally { release(); await returning; }
        if (situation.startsWith('approval after finance closure')) {
          expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
          expect((await money(p.subId)).successes).toBe(0);
          expect(await app.prisma.notification.count({ where: { userId: finance.userId, dedupeKey: `card-session-late-approval:${row.id}` } })).toBe(1);
          if (situation.endsWith('refused void')) {
            expect(await rowOf(row.id)).toMatchObject({ status: 'HELD', failureCode: 'LATE_PROVIDER_APPROVAL', providerVoidState: 'FAILED' });
            expect(ACTIVE_CONFIRMATION_STATES).toContain((await confirmationOf(row.id))?.status);
            const again = await open(p);
            expect(again.statusCode, again.body).toBe(409);
            const book = await resolve(finance, row.id, { action: 'BOOK', providerReference: txnId, amount: 2100 });
            expect(book.json().error?.code, book.body).toBe('PROVIDER_COMPLETION_EVIDENCE_REQUIRED');
            expect((await money(p.subId)).successes).toBe(0);
            // The held late approval blocks every new collection ON ITS OWN, even when its confirmation
            // is resolved (fixture: as when a newer obligation meant it could not be reopened).
            await app.prisma.$transaction((tx) => resolveConfirmationInTx(tx, row.subscriptionId, { cardSessionId: row.id }, 'PROVEN_UNPAID', { actor: finance.userId, reference: 'newer-obligation-fixture' }));
            expect(ACTIVE_CONFIRMATION_STATES).not.toContain((await confirmationOf(row.id))?.status);
            const blocked = await open(p);
            expect(blocked.statusCode, blocked.body).toBe(409);
            expect(blocked.json().error?.code).toBe('PAYMENT_CONFIRMING');
            expect(await readFeePaymentDecision(app.prisma, p.subId)).toMatchObject({ allowed: false, reason: 'PAYMENT_CONFIRMING' });
            expect(await app.prisma.$transaction((tx) => hasConfirmationInTx(tx, p.subId, new Date()))).toBe(true);
          } else expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', providerVoidState: 'VOIDED' });
        } else {
          expect((await rowOf(row.id)).status).toBe('SUCCEEDED');
          expect((await money(p.subId)).successes).toBe(1);
        }
        expect(completions() - before).toBe(1);
      });
    }

    it('a late approval for a session finance already resolved: the decision stands, nothing is rewritten or booked, admins are alerted', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const row = await rowOf(session.sessionId);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const started = new Promise<void>((r) => { entered = r; });
      payment = async (held) => { entered(); await gate; return approve()(held); };
      const returning = bankFramePosts(session.sessionId, 'Y');
      await started;
      try {
        // A finance decision persisted while the completion was answering (fixture).
        await app.prisma.$transaction(async (tx) => {
          await tx.cardSession.update({ where: { id: row.id }, data: { status: 'FAILED', failureCode: 'NOTHING_TAKEN', confirmedAt: new Date(), resolution: 'NOTHING_TAKEN', resolvedBy: finance.userId, resolvedAt: new Date() } });
          await resolveConfirmationInTx(tx, row.subscriptionId, { cardSessionId: row.id }, 'PROVEN_UNPAID', { actor: finance.userId, reference: 'resolved-fixture' });
        });
      } finally { release(); }
      expect((await returning).statusCode).toBe(200);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', resolution: 'NOTHING_TAKEN', providerVoidState: null, paymentId: null });
      expect(await app.prisma.notification.count({ where: { userId: finance.userId, dedupeKey: `card-session-late-approval:${row.id}` } })).toBe(1);
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('the durable claim and provider proof are write-once', async () => {
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const row = await rowOf(session.sessionId);
      const before = completions();
      await bankFramePosts(row.id, 'Y');
      const proven = await rowOf(row.id);
      expect(proven.completionClaimedAt).not.toBeNull();
      expect(proven.completionEvidence).toMatchObject({ Approved: true, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y' } } });
      await expect(app.prisma.cardSession.update({ where: { id: row.id }, data: { completionClaimedAt: new Date(Date.now() + 60_000) } })).rejects.toThrow(/claim is written once/);
      await expect(app.prisma.cardSession.update({ where: { id: row.id }, data: { completionEvidence: { forged: true } } })).rejects.toThrow(/evidence is written once/);
      await serviceOf().confirm(row.id);
      expect(completions() - before).toBe(1);
      expect((await money(p.subId)).successes).toBe(1);
    });

    it('finance closes the session before its completion is claimed: the completion is never sent — nothing to void, no late-approval alert', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const row = await rowOf(session.sessionId);
      const txnId = (await heldOf(session.sessionId))['txnId']!;
      const before = completions();
      const realConfirm = real.confirm.bind(real);
      // Finance's "not paid" lands between the browser's return and the claim.
      real.confirm = async (input) => {
        const [hold] = (await confirmationReviewQueue(app.prisma, row.tenantId)).filter((r) => r.sourceId === row.id);
        await resolveFinanceConfirmation(app.prisma, {
          id: hold!.id, tenantId: row.tenantId, actorId: finance.userId, sourceId: row.id,
          epoch: hold!.epoch, clockVersion: hold!.clockVersion, decision: 'UNPAID', evidenceReference: 'synthetic-portal-check',
        }, async () => undefined);
        return realConfirm(input);
      };
      try {
        expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('FAILED');
      } finally { real.confirm = realConfirm; }
      expect(completions() - before).toBe(0);
      expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', failureCode: 'FINANCE_CONFIRMED_UNPAID', completionClaimedAt: null, providerVoidState: null });
      expect(await app.prisma.notification.count({ where: { dedupeKey: `card-session-late-approval:${row.id}` } })).toBe(0);
      expect((await confirmationOf(row.id))?.status).toBe('PROVEN_UNPAID');
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('a claimed completion whose page record the provider store lost: finance still cannot close it; past its deadline it is voided under the recorded transaction', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const row = await rowOf(session.sessionId);
      const txnId = (await heldOf(session.sessionId))['txnId']!;
      const claimedAt = new Date();
      // A server claimed (and may have sent) the completion, then the card provider's record of the page was lost.
      await app.prisma.cardSession.update({ where: { id: row.id }, data: { completionClaimedAt: claimedAt, providerTransactionRef: txnId } });
      await redis.del(`${PTZ_PREFIX}s:${row.providerSessionRef}`);
      await serviceOf().confirm(row.id, { now: new Date(claimedAt.getTime() + 10_000) });
      expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
      expect((await rowOf(row.id)).status).toBe('OPEN');
      const later = new Date(claimedAt.getTime() + 120_000);
      const [hold] = (await confirmationReviewQueue(app.prisma, row.tenantId, later)).filter((r) => r.sourceId === row.id);
      await expect(resolveFinanceConfirmation(app.prisma, {
        id: hold!.id, tenantId: row.tenantId, actorId: finance.userId, sourceId: row.id,
        epoch: hold!.epoch, clockVersion: hold!.clockVersion, decision: 'UNPAID', evidenceReference: 'synthetic-portal-check',
      }, async () => undefined, later)).rejects.toMatchObject({ code: 'CARD_SESSION_RESOLVE_REQUIRED' });
      await serviceOf().confirm(row.id, { now: new Date(claimedAt.getTime() + 36_000) });
      expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED' });
      expect((await confirmationOf(row.id))?.status).toBe('PROVEN_UNPAID');
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('a durable claim the provider store lost its own copy of: the completion is never sent a second time — the transaction is voided', async () => {
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const row = await rowOf(session.sessionId);
      const txnId = (await heldOf(session.sessionId))['txnId']!;
      const before = completions();
      // The bank's check passes and is noted; this server stops before its completion.
      const realConfirm = real.confirm.bind(real);
      real.confirm = async () => ({ status: 'pending' as const, rawSha256: 'synthetic-pending' });
      try { await bankFramePosts(session.sessionId, 'Y'); } finally { real.confirm = realConfirm; }
      // Another server's durable claim stands (its completion may have gone out); this store has no claim.
      const claimedAt = new Date();
      await app.prisma.cardSession.update({ where: { id: row.id }, data: { completionClaimedAt: claimedAt, providerTransactionRef: txnId } });
      await serviceOf().confirm(row.id, { now: new Date(claimedAt.getTime() + 1_000) });
      expect(completions() - before).toBe(0);
      // [race audit] That server may still be answering: nothing is voided inside its deadline.
      expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
      expect((await rowOf(row.id)).status).toBe('OPEN');
      await serviceOf().confirm(row.id, { now: new Date(claimedAt.getTime() + 36_000) });
      expect(completions() - before).toBe(0);
      expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED' });
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('BOOK refuses an approval without the provider own 3DS proof even after two-person approval', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      const booked = await resolve(finance, sessionId, { action: 'BOOK', providerReference: txnId, amount: 2100 });
      expect(booked.statusCode, booked.body).toBe(409);
      expect(booked.json().error?.code).toBe('PROVIDER_COMPLETION_EVIDENCE_REQUIRED');
      expect(await rowOf(sessionId)).toMatchObject({ status: 'HELD', paymentId: null, bookClaimedAt: null });
      expect((await money(p.subId)).successes).toBe(0);
    });
  });

  describe('[CARDS race audit] claim -> send -> answer: "lost" is decided on the durable claim, under the lock that claims the void', () => {
    type Internals = {
      claimCompletion(sessionId: string, providerRef: string): Promise<CompletionClaim>;
      settlePayNow(session: CardSession, outcome: Extract<CardSessionOutcome, { status: 'succeeded'; purpose: 'PAY_NOW' }>, now: Date): Promise<unknown>;
    };
    const internals = () => serviceOf() as unknown as Internals;
    const voidsOf = (txnId: string) => sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId).length;
    /** A Pay now whose bank check passed and was noted, with no completion sent yet. */
    async function returnedSession(p: Partner) {
      const session = (await open(p)).json().data;
      const realConfirm = real.confirm.bind(real);
      real.confirm = async () => ({ status: 'pending' as const, rawSha256: 'synthetic-pending' });
      try { await bankFramePosts(session.sessionId, 'Y'); } finally { real.confirm = realConfirm; }
      const row = await rowOf(session.sessionId);
      return { row, txnId: (await heldOf(row.id))['txnId']!, key: `${PTZ_PREFIX}s:${row.providerSessionRef}` };
    }

    it('the provider store\'s claim aged while the durable claim waited on a lock: a completion durably claimed moments ago is never voided as lost', async () => {
      const p = await makeStore();
      const { row, txnId, key } = await returnedSession(p);
      // Server A claimed in the provider store 60 s ago, waited on the session lock, then recorded its durable claim and sent.
      await redis.hset(key, { completion: 'sending', completionClaimedAtMs: String(Date.now() - 60_000) });
      const claimedAt = new Date();
      await app.prisma.cardSession.update({ where: { id: row.id }, data: { completionClaimedAt: claimedAt, providerTransactionRef: txnId } });
      await serviceOf().confirm(row.id, { now: new Date(claimedAt.getTime() + 1_000) });
      expect(voidsOf(txnId)).toBe(0);
      expect(await rowOf(row.id)).toMatchObject({ status: 'OPEN', providerVoidState: null });
      // Past the durable claim's own deadline its answer is lost: ONE void.
      await serviceOf().confirm(row.id, { now: new Date(claimedAt.getTime() + 36_000) });
      await serviceOf().confirm(row.id, { now: new Date(claimedAt.getTime() + 37_000) });
      expect(voidsOf(txnId)).toBe(1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED' });
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('a provider-store claim with no durable claim: the completion was never sent — closed as not completed, never voided; the stopped server can no longer send it', async () => {
      const p = await makeStore();
      const { row, txnId, key } = await returnedSession(p);
      const before = completions();
      await redis.hset(key, { completion: 'sending', completionClaimedAtMs: String(Date.now() - 60_000) });
      expect((await serviceOf().confirm(row.id)).status).toBe('FAILED');
      expect(voidsOf(txnId)).toBe(0);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', failureCode: 'COMPLETION_NOT_SENT', completionClaimedAt: null, providerVoidState: null });
      expect((await confirmationOf(row.id))?.status).toBe('PROVEN_UNPAID');
      // The server that held the provider-store claim resumes: its durable claim is refused, nothing is sent.
      expect(await internals().claimCompletion(row.id, txnId)).toBe('closed');
      expect(completions() - before).toBe(0);
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('finance\'s "not paid" racing the durable claim, six times in parallel on a real database: exactly one wins — closed and never sent, or claimed and refused to finance', async () => {
      const finance = await makeFinance();
      const outcomes: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const p = await makeStore();
        const { row, txnId } = await returnedSession(p);
        const [hold] = (await confirmationReviewQueue(app.prisma, row.tenantId)).filter((r) => r.sourceId === row.id);
        const [unpaid, claim] = await Promise.allSettled([
          resolveFinanceConfirmation(app.prisma, {
            id: hold!.id, tenantId: row.tenantId, actorId: finance.userId, sourceId: row.id,
            epoch: hold!.epoch, clockVersion: hold!.clockVersion, decision: 'UNPAID', evidenceReference: 'synthetic-portal-check',
          }, async () => undefined),
          internals().claimCompletion(row.id, txnId),
        ]);
        expect(claim.status).toBe('fulfilled');
        const after = await rowOf(row.id);
        if (claim.status === 'fulfilled' && claim.value === 'send') {
          expect(unpaid).toMatchObject({ status: 'rejected', reason: { code: 'CARD_COMPLETION_IN_FLIGHT' } });
          expect(after.status).toBe('OPEN');
          expect(after.completionClaimedAt).not.toBeNull();
        } else {
          expect(claim).toMatchObject({ value: 'closed' });
          expect(unpaid.status).toBe('fulfilled');
          expect(after).toMatchObject({ status: 'FAILED', failureCode: 'FINANCE_CONFIRMED_UNPAID', completionClaimedAt: null });
        }
        outcomes.push(claim.status === 'fulfilled' ? claim.value : 'rejected');
      }
      expect(outcomes.every((o) => o === 'send' || o === 'closed')).toBe(true);
    });

    it('the same late approval handled by two servers in parallel: exactly ONE void and ONE admin alert; nothing booked', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { row, txnId } = await returnedSession(p);
      const orderId = (await heldOf(row.id))['orderId']!;
      // Closed by an earlier decision while its completion was answering (fixture).
      await app.prisma.$transaction(async (tx) => {
        await tx.cardSession.update({ where: { id: row.id }, data: { status: 'FAILED', failureCode: 'FINANCE_CONFIRMED_UNPAID', confirmedAt: new Date() } });
        await resolveConfirmationInTx(tx, row.subscriptionId, { cardSessionId: row.id }, 'PROVEN_UNPAID', { actor: finance.userId, reference: 'closure-fixture' });
      });
      const reading = readCompletion((approve()({ txnId, orderId }) as { body: unknown }).body, { txnId, orderId, amountMinor: 210_000, currencyCode: 'GYD' });
      if (reading.status !== 'succeeded') throw new Error('fixture: the approval must carry its own proof');
      const outcome = { status: 'succeeded' as const, purpose: 'PAY_NOW' as const, providerRef: txnId, amountMinor: reading.amountMinor, currencyCode: reading.currencyCode, completionEvidence: reading.completionEvidence, rawSha256: createHash('sha256').update(`synthetic-late-approval:${txnId}`).digest('hex') };
      const stale = await rowOf(row.id);
      await Promise.all([internals().settlePayNow(stale, outcome, new Date()), internals().settlePayNow(stale, outcome, new Date())]);
      expect(voidsOf(txnId)).toBe(1);
      expect(await app.prisma.notification.count({ where: { userId: finance.userId, dedupeKey: `card-session-late-approval:${row.id}` } })).toBe(1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', providerVoidState: 'VOIDED', paymentId: null });
      expect((await money(p.subId)).successes).toBe(0);
    });
  });

  describe('[concurrency · one money movement] parallel calls on a real database: each money step at most once per session, and never a booking beside a void or refund', () => {
    const voids = (txnId: string) => sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId).length;
    const refunds = (txnId: string) => sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId).length;

    it('two returns racing, then three confirmations racing: ONE completion to the provider, the week booked ONCE, one captured payment', async () => {
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const before = completions();
      const pages = await Promise.all([bankFramePosts(session.sessionId, 'Y'), bankFramePosts(session.sessionId, 'Y')]);
      await Promise.all([serviceOf().confirm(session.sessionId), serviceOf().confirm(session.sessionId), serviceOf().confirm(session.sessionId)]);
      expect(pages.map((r) => pageState(r.body)).sort()).toContain('SUCCEEDED');
      expect(completions() - before).toBe(1);
      const m = await money(p.subId);
      expect(m.successes).toBe(1);
      expect(m.payments.filter((x) => x.status === 'CAPTURED')).toHaveLength(1);
      expect(await rowOf(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', providerVoidState: null, providerRefundState: null });
      expect(voids((await heldOf(session.sessionId))['txnId']!)).toBe(0);
    });

    it('an approval Swift cannot book, returned twice and confirmed three times in parallel: ONE completion, ONE void, nothing booked', async () => {
      payment = approve({ RiskManagement: undefined });
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const txnId = (await heldOf(session.sessionId))['txnId']!;
      const before = completions();
      await Promise.all([bankFramePosts(session.sessionId, 'Y'), bankFramePosts(session.sessionId, 'Y')]);
      await Promise.all([serviceOf().confirm(session.sessionId), serviceOf().confirm(session.sessionId), serviceOf().confirm(session.sessionId)]);
      expect(completions() - before).toBe(1);
      expect(voids(txnId)).toBe(1);
      expect((await money(p.subId)).successes).toBe(0);
      expect((await money(p.subId)).payments).toHaveLength(0);
      expect(await rowOf(session.sessionId)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED', paymentId: null });
    });

    it('a confirmation while another one\'s void is in flight sends no second void: the database claim holds, not only the provider\'s own', async () => {
      payment = approve({ RiskManagement: undefined });
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const txnId = (await heldOf(session.sessionId))['txnId']!;
      const service = serviceOf();
      const provider = (service as unknown as { rail: () => CardRailProvider }).rail();
      const realVoid = provider.voidPayment!.bind(provider);
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      provider.voidPayment = async (input) => { calls += 1; if (calls === 1) await gate; return realVoid(input); };
      try {
        const first = bankFramePosts(session.sessionId, 'Y'); // its confirmation claims the void, then waits inside the provider call
        for (let i = 0; i < 100 && (await rowOf(session.sessionId)).providerVoidState !== 'SENDING'; i += 1) await new Promise((r) => setTimeout(r, 20));
        expect((await rowOf(session.sessionId)).providerVoidState).toBe('SENDING');
        await service.confirm(session.sessionId);
        await service.confirm(session.sessionId, { now: new Date(Date.now() + 30_000) });
        expect(calls).toBe(1);
        release();
        expect(pageState((await first).body)).toBe('FAILED');
      } finally {
        release();
        provider.voidPayment = realVoid;
      }
      expect(calls).toBe(1);
      expect(voids(txnId)).toBe(1);
      expect(await rowOf(session.sessionId)).toMatchObject({ status: 'FAILED', failureCode: 'VOIDED_UNPROVEN', providerVoidState: 'VOIDED' });
    });

    it('two refund decisions racing on one held payment: ONE refund call', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      const row = await rowOf(sessionId);
      const base = { sessionId, tenantId: row.tenantId, action: 'REFUND' as const, providerReference: txnId, amount: 2100, adminUserId: finance.userId };
      const results = await Promise.allSettled([serviceOf().resolveHeld(base), serviceOf().resolveHeld(base)]);
      expect(refunds(txnId)).toBe(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(['REFUND_IN_FLIGHT', 'REFUND_ALREADY_SENT', 'CARD_SESSION_NOT_HELD']).toContain((r.reason as { code?: string }).code);
      expect(await rowOf(sessionId)).toMatchObject({ status: 'FAILED', resolution: 'REFUNDED', providerRefundState: 'REFUNDED', bookClaimedAt: null });
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('an approval that arrives after Swift sent a void for its session is never booked: held for a person', async () => {
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const txnId = (await heldOf(session.sessionId))['txnId']!;
      // A void in flight for this session (another server's claim).
      await app.prisma.cardSession.update({ where: { id: session.sessionId }, data: { providerVoidState: 'SENDING', providerVoidAt: new Date(), providerTransactionRef: txnId } });
      expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('PENDING');
      expect(await rowOf(session.sessionId)).toMatchObject({ status: 'HELD', failureCode: 'APPROVED_UNPROVEN', paymentId: null });
      const m = await money(p.subId);
      expect(m.successes).toBe(0);
      expect(m.payments).toHaveLength(0);
    });

    it('[booking and success commit together] a week booked while its session still reads open (the old crash window) only ever becomes SUCCEEDED: never completed again, voided or held', async () => {
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const txnId = (await heldOf(session.sessionId))['txnId']!;
      const row = await rowOf(session.sessionId);
      const paymentId = (await app.prisma.subscriptionPayment.create({
        data: {
          subscriptionId: p.subId, amount: 2100, status: 'UNKNOWN', paymentMethod: 'CARD', clientKey: `cardpay:${session.sessionId}`, purpose: 'CARD_PAY_NOW',
          failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD', cardSessionId: session.sessionId },
          periodStart: row.periodStart!, periodEnd: new Date(row.periodStart!.getTime() + 7 * DAY),
        },
        select: { id: true },
      })).id;
      await app.prisma.cardSession.update({ where: { id: session.sessionId }, data: { paymentId } });
      const billing = (serviceOf() as unknown as { billing: BillingService }).billing;
      // The booking commits WITHOUT the session's own mark: what a crash between the two used to leave.
      expect((await billing.settleHostedCardPayment({ subscriptionId: p.subId, paymentId, providerRef: txnId })).outcome).toBe('advanced');
      expect((await rowOf(session.sessionId)).status).toBe('OPEN');
      expect((await money(p.subId)).successes).toBe(1);
      // Even an answer Swift would void, returned and confirmed in parallel: the session is SUCCEEDED, nothing else happens.
      payment = approve({ RiskManagement: undefined });
      const before = completions();
      const pages = await Promise.all([bankFramePosts(session.sessionId, 'Y'), serviceOf().confirm(session.sessionId), serviceOf().confirm(session.sessionId, { now: new Date(row.expiresAt.getTime() + 60_000) })]);
      expect(pageState(pages[0].body)).toBe('SUCCEEDED');
      expect(completions()).toBe(before);
      expect(sent('/api/void').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
      expect(await rowOf(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', providerVoidState: null });
      expect((await money(p.subId)).successes).toBe(1);
    });

    it('[booking and success commit together] a session that can no longer take its success books nothing: the booking rolls back whole', async () => {
      const p = await makeStore();
      const session = (await open(p)).json().data;
      const row = await rowOf(session.sessionId);
      const paymentId = (await app.prisma.subscriptionPayment.create({
        data: {
          subscriptionId: p.subId, amount: 2100, status: 'UNKNOWN', paymentMethod: 'CARD', clientKey: `cardpay:${session.sessionId}`, purpose: 'CARD_PAY_NOW',
          failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD', cardSessionId: session.sessionId },
          periodStart: row.periodStart!, periodEnd: new Date(row.periodStart!.getTime() + 7 * DAY),
        },
        select: { id: true },
      })).id;
      await app.prisma.cardSession.update({ where: { id: session.sessionId }, data: { paymentId } });
      await app.prisma.cardSession.update({ where: { id: session.sessionId }, data: { status: 'FAILED', failureCode: 'DECLINED', confirmedAt: new Date() } });
      const service = serviceOf() as unknown as { billing: BillingService; succeedInSettlement: (id: string, now: Date, from: 'LIVE') => (tx: unknown) => Promise<void> };
      await expect(service.billing.settleHostedCardPayment({
        subscriptionId: p.subId, paymentId, providerRef: (await heldOf(session.sessionId))['txnId']!, inSettlement: service.succeedInSettlement(session.sessionId, new Date(), 'LIVE') as never,
      })).rejects.toMatchObject({ code: 'CARD_SESSION_NOT_OPEN' });
      const m = await money(p.subId);
      expect(m.successes).toBe(0);
      expect(m.payments.find((x) => x.id === paymentId)?.status).toBe('UNKNOWN');
      expect((await rowOf(session.sessionId)).status).toBe('FAILED');
    });

    it('the database itself refuses a booking beside a void or refund, a void beside a payment, and a refund of a booked payment', async () => {
      const sessionOf = async () => {
        const p = await makeStore();
        const sessionId = (await open(p)).json().data.sessionId as string;
        const paymentId = (await app.prisma.subscriptionPayment.create({
          data: {
            subscriptionId: p.subId, amount: 2100, status: 'UNKNOWN', paymentMethod: 'CARD', clientKey: `cardpay:${sessionId}`, purpose: 'CARD_PAY_NOW',
            periodStart: new Date(), periodEnd: new Date(Date.now() + 7 * DAY),
          },
          select: { id: true },
        })).id;
        return { sessionId, paymentId };
      };
      const set = (id: string, data: Record<string, unknown>) => app.prisma.cardSession.update({ where: { id }, data: data as never });
      // A void in flight: no payment, no booking claim, no success.
      const a = await sessionOf();
      await set(a.sessionId, { providerVoidState: 'SENDING', providerVoidAt: new Date(), providerTransactionRef: nanoid(12) });
      await expect(set(a.sessionId, { paymentId: a.paymentId })).rejects.toThrow(/never takes a payment/);
      await expect(set(a.sessionId, { bookClaimedAt: new Date() })).rejects.toThrow(/never booked/);
      await expect(set(a.sessionId, { status: 'SUCCEEDED' })).rejects.toThrow(/never booked/);
      // Its void refused by the provider (nothing moved): then, and only then, it may be booked.
      await set(a.sessionId, { providerVoidState: 'FAILED' });
      await set(a.sessionId, { status: 'HELD' });
      await expect(set(a.sessionId, { paymentId: a.paymentId, bookClaimedAt: new Date() })).resolves.toBeTruthy();
      // A payment on the session: never voided afterwards. A refund sent: never booked afterwards.
      const b = await sessionOf();
      await set(b.sessionId, { paymentId: b.paymentId, providerTransactionRef: nanoid(12) });
      await expect(set(b.sessionId, { providerVoidState: 'SENDING' })).rejects.toThrow(/never voided/);
      await set(b.sessionId, { status: 'HELD' });
      await set(b.sessionId, { providerRefundState: 'SENDING' });
      await expect(set(b.sessionId, { bookClaimedAt: new Date() })).rejects.toThrow(/never booked/);
      await expect(set(b.sessionId, { status: 'SUCCEEDED' })).rejects.toThrow(/never booked/);
      // A booked (captured) payment: never refunded here.
      const c = await sessionOf();
      await set(c.sessionId, { paymentId: c.paymentId, providerTransactionRef: nanoid(12) });
      await app.prisma.subscriptionPayment.update({ where: { id: c.paymentId }, data: { status: 'CAPTURED', externalRef: nanoid(12), paidAt: new Date() } });
      await expect(set(c.sessionId, { providerRefundState: 'SENDING' })).rejects.toThrow(/never refunded here/);
    });
  });

  describe('[review S2-2] finance resolves a HELD card payment: two people, once', () => {
    it('one admin alone changes nothing: 202 APPROVAL_REQUIRED', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      const alone = await ptz.inject({
        method: 'POST', url: `/api/v1/admin/billing/card-sessions/${sessionId}/resolve`,
        headers: { authorization: `Bearer ${finance.token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
        payload: { action: 'BOOK', providerReference: txnId, amount: 2100 },
      });
      expect(alone.statusCode, alone.body).toBe(202);
      expect(alone.json().error.code).toBe('APPROVAL_REQUIRED');
      expect((await rowOf(sessionId)).status).toBe('HELD');
      expect((await money(p.subId)).successes).toBe(0);
      const partner = await ptz.inject({ method: 'POST', url: `/api/v1/admin/billing/card-sessions/${sessionId}/resolve`, headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' }, payload: { action: 'BOOK', providerReference: txnId, amount: 2100 } });
      expect(partner.statusCode).toBe(403);
    });

    it('BOOK: only the recorded transaction, only this week\'s exact price; missing provider 3DS proof still refuses BOOK', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      const wrongRef = await resolve(finance, sessionId, { action: 'BOOK', providerReference: '00000000-0000-4000-8000-000000000000', amount: 2100 });
      expect(wrongRef.json().error?.code, wrongRef.body).toBe('PROVIDER_REFERENCE_MISMATCH');
      const wrongAmount = await resolve(finance, sessionId, { action: 'BOOK', providerReference: txnId, amount: 2000 });
      expect(wrongAmount.json().error?.code, wrongAmount.body).toBe('AMOUNT_NOT_THE_PRICE');
      expect((await money(p.subId)).successes).toBe(0);
      const booked = await resolve(finance, sessionId, { action: 'BOOK', providerReference: txnId, amount: 2100 });
      expect(booked.statusCode, booked.body).toBe(409);
      expect(booked.json().error?.code).toBe('PROVIDER_COMPLETION_EVIDENCE_REQUIRED');
      expect((await money(p.subId)).successes).toBe(0);
      expect(await rowOf(sessionId)).toMatchObject({ status: 'HELD', paymentId: null, bookClaimedAt: null });
      expect(ACTIVE_CONFIRMATION_STATES).toContain((await confirmationOf(sessionId))?.status);
    });

    it('BOOK with the provider\'s own approved completion and its 3-D Secure proof: only the recorded transaction, only this week\'s exact price; then the week is booked ONCE', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await verifiedHeldPayment(p);
      const wrongRef = await resolve(finance, sessionId, { action: 'BOOK', providerReference: '00000000-0000-4000-8000-000000000000', amount: 2100 });
      expect(wrongRef.json().error?.code, wrongRef.body).toBe('PROVIDER_REFERENCE_MISMATCH');
      const wrongAmount = await resolve(finance, sessionId, { action: 'BOOK', providerReference: txnId, amount: 2000 });
      expect(wrongAmount.json().error?.code, wrongAmount.body).toBe('AMOUNT_NOT_THE_PRICE');
      expect((await money(p.subId)).successes).toBe(0);
      const booked = await resolve(finance, sessionId, { action: 'BOOK', providerReference: txnId, amount: 2100 });
      expect(booked.statusCode, booked.body).toBe(200);
      expect(booked.json().data).toMatchObject({ status: 'SUCCEEDED', resolution: 'BOOKED' });
      expect((await money(p.subId)).successes).toBe(1);
      expect(await rowOf(sessionId)).toMatchObject({ status: 'SUCCEEDED', resolution: 'BOOKED', resolvedBy: finance.userId });
      expect(ACTIVE_CONFIRMATION_STATES).not.toContain((await confirmationOf(sessionId))?.status);
      const again = await resolve(finance, sessionId, { action: 'BOOK', providerReference: txnId, amount: 2100 });
      expect(again.json().error?.code, again.body).toBe('CARD_SESSION_NOT_HELD');
      expect((await money(p.subId)).successes).toBe(1);
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
    });

    it('REFUND: one refund of the recorded transaction, durably claimed; closes FAILED only once refunded', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      refundAnswer = () => 'network';
      const lost = await resolve(finance, sessionId, { action: 'REFUND', providerReference: txnId, amount: 2100 });
      expect(lost.statusCode, lost.body).toBe(200);
      expect(lost.json().data).toMatchObject({ status: 'HELD', refund: 'unknown' });
      expect((await rowOf(sessionId)).providerRefundState).toBe('UNKNOWN');
      refundAnswer = adjusted;
      const again = await resolve(finance, sessionId, { action: 'REFUND', providerReference: txnId, amount: 2100 });
      expect(again.json().error?.code, again.body).toBe('REFUND_ALREADY_SENT');
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toEqual([
        { Refund: true, TransactionIdentifier: txnId, TotalAmount: 2100, CurrencyCode: '328' },
      ]);
      expect((await money(p.subId)).successes).toBe(0);
      // A refund that may have gone through is never booked; finance records what the portal shows.
      const book = await resolve(finance, sessionId, { action: 'BOOK', providerReference: txnId, amount: 2100 });
      expect(book.json().error?.code, book.body).toBe('REFUND_SENT');
      const recorded = await resolve(finance, sessionId, { action: 'REFUNDED_IN_PORTAL', providerReference: txnId, amount: 2100 });
      expect(recorded.statusCode, recorded.body).toBe(200);
      expect(recorded.json().data).toMatchObject({ status: 'FAILED', resolution: 'REFUNDED' });
      expect(await rowOf(sessionId)).toMatchObject({ failureCode: 'REFUNDED_IN_PORTAL', resolvedBy: finance.userId });
      expect((await confirmationOf(sessionId))?.status).toBe('PROVEN_UNPAID');
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('REFUND answered: the session closes FAILED, refunded, its confirmation resolved — and the card choice comes back', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      const done = await resolve(finance, sessionId, { action: 'REFUND', providerReference: txnId, amount: 2100 });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().data).toMatchObject({ status: 'FAILED', resolution: 'REFUNDED', refund: 'succeeded' });
      expect(await rowOf(sessionId)).toMatchObject({ failureCode: 'REFUNDED_BY_FINANCE', providerRefundState: 'REFUNDED', resolvedBy: finance.userId });
      expect((await confirmationOf(sessionId))?.status).toBe('PROVEN_UNPAID');
      expect((await money(p.subId)).successes).toBe(0);
      expect((await call(p, 'GET', '/subscription')).json().data.payActions[1]).toMatchObject({ state: 'live' });
    });

    it('[hypothesis: book AND refund] while a BOOK is booking, a refund or a "nothing taken" is refused; the week is booked once and nothing is refunded', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await verifiedHeldPayment(p);
      const row = await rowOf(sessionId);
      const service = serviceOf();
      const billing = (service as unknown as { billing: BillingService }).billing;
      const realSettle = billing.settleHostedCardPayment.bind(billing);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      billing.settleHostedCardPayment = async (input) => { await gate; return realSettle(input); };
      try {
        const base = { sessionId, tenantId: row.tenantId, providerReference: txnId, amount: 2100, adminUserId: finance.userId };
        const booking = service.resolveHeld({ ...base, action: 'BOOK' });
        for (let i = 0; i < 50 && !(await rowOf(sessionId)).bookClaimedAt; i += 1) await new Promise((r) => setTimeout(r, 20));
        expect((await rowOf(sessionId)).bookClaimedAt).not.toBeNull();
        for (const action of ['REFUND', 'NOTHING_TAKEN', 'REFUNDED_IN_PORTAL'] as const) {
          await expect(service.resolveHeld({ ...base, action }), action).rejects.toMatchObject({ code: 'BOOKING_IN_PROGRESS' });
        }
        release();
        expect(await booking).toMatchObject({ status: 'SUCCEEDED', resolution: 'BOOKED' });
      } finally {
        release();
        billing.settleHostedCardPayment = realSettle;
      }
      expect((await money(p.subId)).successes).toBe(1);
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
      // Once booked, nothing can refund or close it here.
      for (const action of ['REFUND', 'NOTHING_TAKEN'] as const) {
        const res = await resolve(finance, sessionId, { action, providerReference: txnId, amount: 2100 });
        expect(res.json().error?.code, res.body).toBe('CARD_SESSION_NOT_HELD');
      }
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
    });

    it('[hypothesis: refund AND close] while a refund is being sent, nothing can book, close or record the payment; the refund\'s answer closes it once', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      const row = await rowOf(sessionId);
      const service = serviceOf();
      const provider = (service as unknown as { rail: () => CardRailProvider }).rail();
      const realRefund = provider.refund.bind(provider);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      provider.refund = async (input) => { await gate; return realRefund(input); };
      try {
        const base = { sessionId, tenantId: row.tenantId, providerReference: txnId, amount: 2100, adminUserId: finance.userId };
        const refunding = service.resolveHeld({ ...base, action: 'REFUND' });
        for (let i = 0; i < 50 && (await rowOf(sessionId)).providerRefundState !== 'SENDING'; i += 1) await new Promise((r) => setTimeout(r, 20));
        expect((await rowOf(sessionId)).providerRefundState).toBe('SENDING');
        for (const action of ['BOOK', 'NOTHING_TAKEN', 'REFUNDED_IN_PORTAL'] as const) {
          await expect(service.resolveHeld({ ...base, action }), action).rejects.toMatchObject({ code: 'REFUND_IN_FLIGHT' });
        }
        release();
        expect(await refunding).toMatchObject({ status: 'FAILED', resolution: 'REFUNDED', refund: 'succeeded' });
      } finally {
        release();
        provider.refund = realRefund;
      }
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(1);
      expect(await rowOf(sessionId)).toMatchObject({ failureCode: 'REFUNDED_BY_FINANCE', bookClaimedAt: null });
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('[hypothesis: booked twice] two BOOK decisions racing book the week ONCE (one payment row, one success)', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await verifiedHeldPayment(p);
      const row = await rowOf(sessionId);
      const base = { sessionId, tenantId: row.tenantId, action: 'BOOK' as const, providerReference: txnId, amount: 2100, adminUserId: finance.userId };
      const results = await Promise.allSettled([serviceOf().resolveHeld(base), serviceOf().resolveHeld(base), serviceOf().resolveHeld(base)]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of results) if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('CARD_SESSION_NOT_HELD');
      const m = await money(p.subId);
      expect(m.successes).toBe(1);
      expect(m.payments.filter((x) => x.status === 'CAPTURED')).toHaveLength(1);
      expect(await rowOf(sessionId)).toMatchObject({ status: 'SUCCEEDED', resolution: 'BOOKED' });
    });

    it('[hypothesis: void AND book] a payment whose void may have gone through is never booked; it is refunded instead', async () => {
      payment = () => 'network';
      voidAnswer = () => 'network';
      const finance = await makeFinance();
      const p = await makeStore();
      const session = (await open(p)).json().data;
      expect(pageState((await bankFramePosts(session.sessionId, 'Y')).body)).toBe('PENDING');
      const txnId = (await rowOf(session.sessionId)).providerTransactionRef!;
      expect(await rowOf(session.sessionId)).toMatchObject({ status: 'HELD', providerVoidState: 'UNKNOWN' });
      const book = await resolve(finance, session.sessionId, { action: 'BOOK', providerReference: txnId, amount: 2100 });
      expect(book.json().error?.code, book.body).toBe('VOID_MAY_HAVE_TAKEN_EFFECT');
      expect((await money(p.subId)).successes).toBe(0);
      const refund = await resolve(finance, session.sessionId, { action: 'REFUND', providerReference: txnId, amount: 2100 });
      expect(refund.json().data, refund.body).toMatchObject({ status: 'FAILED', resolution: 'REFUNDED', refund: 'succeeded' });
      expect((await money(p.subId)).successes).toBe(0);
    });

    it('[hypothesis: authorization] a session of another tenant does not exist for this admin — nothing changes', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      for (const action of ['BOOK', 'REFUND', 'NOTHING_TAKEN'] as const) {
        await expect(serviceOf().resolveHeld({ sessionId, tenantId: 'not-this-sessions-tenant', action, providerReference: txnId, amount: 2100, adminUserId: finance.userId }))
          .rejects.toMatchObject({ statusCode: 404 });
      }
      expect(await rowOf(sessionId)).toMatchObject({ status: 'HELD', resolution: null, bookClaimedAt: null, providerRefundState: null });
      expect((await money(p.subId)).successes).toBe(0);
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
    });

    it('[review S2-2] the general payment-confirmation review can never close a held card payment as unpaid: it goes to the card session', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId } = await heldPayment(p);
      const row = await rowOf(sessionId);
      const [hold] = (await confirmationReviewQueue(app.prisma, row.tenantId)).filter((r) => r.sourceId === sessionId);
      expect(hold).toBeDefined();
      const audit = async () => undefined;
      await expect(resolveFinanceConfirmation(app.prisma, {
        id: hold!.id, tenantId: row.tenantId, actorId: finance.userId, sourceId: sessionId, epoch: hold!.epoch, clockVersion: hold!.clockVersion,
        decision: 'UNPAID', evidenceReference: 'portal-checked',
      }, audit)).rejects.toMatchObject({ code: 'CARD_SESSION_RESOLVE_REQUIRED' });
      expect(await rowOf(sessionId)).toMatchObject({ status: 'HELD', resolution: null });
      expect(ACTIVE_CONFIRMATION_STATES).toContain((await confirmationOf(sessionId))?.status);
    });

    it('NOTHING_TAKEN: closes FAILED with the decision written once', async () => {
      const finance = await makeFinance();
      const p = await makeStore();
      const { sessionId, txnId } = await heldPayment(p);
      const done = await resolve(finance, sessionId, { action: 'NOTHING_TAKEN', providerReference: txnId, amount: 2100 });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().data).toMatchObject({ status: 'FAILED', resolution: 'NOTHING_TAKEN' });
      expect((await confirmationOf(sessionId))?.status).toBe('PROVEN_UNPAID');
      await expect(app.prisma.cardSession.update({ where: { id: sessionId }, data: { resolution: 'BOOKED' } })).rejects.toThrow();
      // [ADM-002] One audit row for the decision, written with it: who, the action and the transaction.
      const rows = await app.prisma.auditLog.findMany({ where: { entityId: sessionId, action: { startsWith: 'ADMIN POST' } } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(finance.userId);
      expect(JSON.stringify(rows[0]!.changes)).toContain('NOTHING_TAKEN');
      expect(JSON.stringify(rows[0]!.changes)).toContain(txnId);
      expect(sent('/api/refund').filter((b) => b['TransactionIdentifier'] === txnId)).toHaveLength(0);
    });
  });

  it('the result can also arrive as a form field holding the JSON; a result naming another page completes nothing', async () => {
    const p = await makeRider();
    const session = (await open(p)).json().data;
    const held = await heldOf(session.sessionId);
    const forged = { IsoResponseCode: '3D0', SpiToken: 'spi-someone-else', TransactionIdentifier: held['txnId'], RiskManagement: { ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'Y' } } };
    const before = completions();
    const res = await ptz.inject({ method: 'POST', url: merchantResponsePath(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `Response=${encodeURIComponent(JSON.stringify(forged))}` });
    expect(pageState(res.body)).toBe('FAILED');
    expect(completions()).toBe(before);
    expect((await money(p.subId)).successes).toBe(0);
  });

  it('saving a card is never offered by this provider: ENROLL 409 ADD_CARD_OFF, even with saving switched on', async () => {
    const p = await makeRider();
    const res = await open(p, 'ENROLL');
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ADD_CARD_OFF');
  });

  it('an unknown page reference, or card payments off: 404 with nothing served', async () => {
    expect((await ptz.inject({ method: 'GET', url: '/api/v1/billing/card/pay/ptz_000000000000000000000000' })).statusCode).toBe(404);
    const p = await makeRider();
    const session = (await open(p)).json().data;
    process.env['CARD_RAIL_V2'] = '0';
    const res = await ptz.inject({ method: 'GET', url: pathOf(session.hostedUrl) });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<iframe');
  });
});
