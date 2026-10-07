import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Prisma, SubscriptionPayment, SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService, type BillingObserver } from '../modules/billing/billing.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { CARD_ON_FILE_CONSENT_VERSION, CARD_SESSION_TTL_MS, CardRailService } from '../modules/billing/card-rail.service';
import { cardRailWorkerSource, sweepCardSessions } from '../modules/billing/card-rail-worker';
import { openVaultToken } from '../modules/billing/card-vault';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxPaymentProvider } from '../providers/payment/payment-provider';
import { SimulatorCardRailProvider, type SimulatorScenario } from '../providers/card/simulator-provider';
import type { CardRailProvider } from '../providers/card/card-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { deleteRunKeys, runKeyPrefix } from './helpers/card-sim-keys';

// ---------------------------------------------------------------------------
// [PT-1] The hosted card loop, end to end, on the real simulator and the real
// billing engine: a session is the intent; a return is an observation that
// grants nothing; only the provider's server-side answer enrols a card or
// books a week — once. These are the AH.10.10 card red tests this layer can
// reach (the routes that call it arrive in PT-2).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const PHONE = `+59200742${String(Date.now()).slice(-4)}`;
const OTHER_TENANT = `pt1-card-${RUN.toLowerCase()}`;
/** [AX297 F3] This run's own simulator namespace: the teardown deletes exactly it. */
const PREFIX = runKeyPrefix(RUN);
const WEEKLY = 12000;
let app: FastifyInstance;
let redis: Redis;
let sim: SimulatorCardRailProvider;
let billing: BillingService;
let card: CardRailService;
let notifications: NotificationService;
/** A card service on another provider (the services resolve theirs once). */
const cardWith = (p: CardRailProvider) => new CardRailService(app.prisma, notifications, billing, () => p);
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

async function partner(opts: { status?: SubscriptionStatus; due?: Date; failedAttempts?: number } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE}${String(seq).padStart(2, '0')}`, firstName: 'Card', lastName: `P${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
  const due = opts.due ?? new Date(Date.now() + 3 * DAY);
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: WEEKLY,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      failedAttempts: opts.failedAttempts ?? 0,
      ...(opts.status === 'SUSPENDED' ? { suspendedAt: new Date() } : {}),
    },
  });
  subIds.push(sub.id);
  // [PT-4 · review S2-1] The simulator moves no money: it books a week only for
  // a subscription listed as a TEST subscription. Every partner here is one.
  process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'] = subIds.join(',');
  return { userId: user.id, subId: sub.id };
}

const start = (p: { userId: string; subId: string }, purpose: 'ENROLL' | 'PAY_NOW', extra: { idempotencyKey?: string; now?: Date } = {}) =>
  card.startSession({ userId: p.userId, subscriptionId: p.subId, purpose, ...(purpose === 'ENROLL' ? { consentVersion: CARD_ON_FILE_CONSENT_VERSION } : {}), ...extra });

/** The partner presses a button on the simulator page; the browser is sent back. */
async function press(sessionId: string, scenario: SimulatorScenario) {
  const row = await app.prisma.cardSession.findUniqueOrThrow({ where: { id: sessionId } });
  const { redirectUrl } = await sim.choose(row.providerSessionRef!, scenario);
  const u = new URL(redirectUrl, 'http://swift.invalid');
  const params = Object.fromEntries(u.searchParams.entries());
  return { sessionId: params['session']!, state: params['state']!, params };
}

const returnWith = (r: { sessionId: string; state: string; params: Record<string, string> }, extra: { actorUserId?: string; expectedPurpose?: 'ENROLL' | 'PAY_NOW'; now?: Date; state?: string } = {}) =>
  card.handleReturn({ sessionId: r.sessionId, state: extra.state ?? r.state, params: r.params, ...(extra.actorUserId ? { actorUserId: extra.actorUserId } : {}), ...(extra.expectedPurpose ? { expectedPurpose: extra.expectedPurpose } : {}), ...(extra.now ? { now: extra.now } : {}) });

async function money(subId: string) {
  const [sub, payments, successes, ledger, instruments, bank] = await Promise.all([
    app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } }),
    app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId } }),
    app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } }),
    app.prisma.ledgerTransaction.count({ where: { idempotencyKey: { startsWith: `ledger:success:${subId}:` } } }),
    app.prisma.paymentInstrument.findMany({ where: { subscriptionId: subId }, orderBy: { createdAt: 'asc' } }),
    app.prisma.billingEvent.count({ where: { subscriptionId: subId, idempotencyKey: { startsWith: 'bank:' } } }),
  ]);
  return { sub, payments, successes, ledger, instruments, bank };
}

const observations = (sessionId: string) =>
  app.prisma.cardObservation.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' }, select: { source: true, parsedStatus: true, verdict: true } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382/5';
  // A fresh random master key per run: the vault is really sealed, and nothing secret is written down.
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  process.env['CARD_RAIL_V2'] = '1';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  redis = new Redis(process.env['REDIS_URL']!);
  sim = new SimulatorCardRailProvider(redis, { account: `pt1-${RUN}`, keyPrefix: PREFIX });
  notifications = new NotificationService(app.prisma, app.io);
  billing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), undefined, () => sim);
  card = new CardRailService(app.prisma, notifications, billing, () => sim);
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: OTHER_TENANT, name: 'PT-1 other operator', slug: OTHER_TENANT, kind: 'REVIEW', purgeProtected: true } }), 'pt1-card-test');
});

afterEach(() => {
  process.env['CARD_RAIL_V2'] = '1';
  delete process.env['CARD_RAIL_KILL'];
});

afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds);
  delete process.env['CARD_RAIL_V2'];
  delete process.env['CARD_RAIL_TEST_SUBSCRIPTIONS'];
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  // Purge the synthetic payers before their preserved authority sources.
  // Deleting the subscriptions cascades their cards, sessions and payments;
  // observations are append-only evidence and stay, keyed to this run's ids.
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await runWithoutTenant(async () => {
    await app.prisma.tenant.updateMany({ where: { id: OTHER_TENANT }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
  }, 'pt1-card-test');
  await deleteRunKeys(redis, PREFIX);
  await redis.quit();
  await app.close();
});

describe('ENROLL: the provider’s answer adds the card — sealed, bound, shown as brand / last 4 / expiry only', () => {
  it('Approve → return → confirm: one ACTIVE card, the vault token sealed at rest, the card rail chosen, the evidence recorded', async () => {
    const p = await partner();
    const session = await start(p, 'ENROLL');
    expect(session).toMatchObject({ purpose: 'ENROLL', status: 'OPEN', testMode: true, testModeLabel: expect.stringMatching(/TEST PAGE/) });
    expect(Object.keys(session).sort()).toEqual(['expiresAt', 'hostedUrl', 'purpose', 'sessionId', 'status', 'testMode', 'testModeLabel']);
    expect(Date.parse(session.expiresAt) - Date.now()).toBeLessThanOrEqual(CARD_SESSION_TTL_MS);

    const back = await press(session.sessionId, 'APPROVE');
    expect(await returnWith(back)).toMatchObject({ accepted: true, verdict: 'ACCEPTED' });
    // The return alone granted nothing.
    expect((await money(p.subId)).instruments).toHaveLength(0);

    const confirmed = await card.confirm(session.sessionId);
    expect(confirmed).toMatchObject({ status: 'SUCCEEDED', instrument: { brand: 'SIMULATED', last4: '4242', expMonth: 12, status: 'ACTIVE' } });
    expect(Object.keys(confirmed.instrument!).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'last4', 'status']);

    const { sub, instruments } = await money(p.subId);
    expect(sub.billingMethod).toBe('CARD');
    expect(sub.paymentToken).toBeNull(); // v2 never writes the legacy token
    expect(instruments).toHaveLength(1);
    const [inst] = instruments;
    expect(inst).toMatchObject({ provider: 'simulator', environment: 'sandbox', providerAccount: `pt1-${RUN}`, consentVersion: CARD_ON_FILE_CONSENT_VERSION });
    // Sealed at rest: the bytes do not contain the token; only the vault opens it.
    const token = await openVaultToken(inst!);
    expect(token).toMatch(/^simtok_ok_[0-9a-f]{24}$/);
    expect(Buffer.from(inst!.vaultTokenSealed).includes(Buffer.from(token))).toBe(false);
    expect(Buffer.from(inst!.vaultTokenDek).length).toBeGreaterThan(32);

    expect(await observations(session.sessionId)).toEqual([
      { source: 'RETURN', parsedStatus: 'SUCCEEDED', verdict: 'ACCEPTED' },
      { source: 'CONFIRM', parsedStatus: 'SUCCEEDED', verdict: 'ACCEPTED' },
    ]);
    // Confirming again changes nothing.
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', instrument: { id: inst!.id } });
    expect((await money(p.subId)).instruments).toHaveLength(1);
  });

  it('a second card REPLACES the first in one step; removing a card REVOKES it; the list is brand / last 4 / expiry only', async () => {
    const p = await partner();
    const first = await start(p, 'ENROLL');
    await returnWith(await press(first.sessionId, 'APPROVE'));
    await card.confirm(first.sessionId);
    const second = await start(p, 'ENROLL');
    await returnWith(await press(second.sessionId, 'APPROVE_3DS_LATER'));
    const replaced = await card.confirm(second.sessionId);
    const [old, current] = (await money(p.subId)).instruments;
    expect(old).toMatchObject({ status: 'REPLACED', replacedById: current!.id, replacedAt: expect.any(Date) });
    expect(current).toMatchObject({ status: 'ACTIVE', last4: '3155' });
    expect(replaced.instrument?.id).toBe(current!.id);

    const removed = await card.removeInstrument({ userId: p.userId, instrumentId: current!.id });
    expect(removed).toEqual({ card: { id: current!.id, brand: 'SIMULATED', last4: '3155', expMonth: 12, expYear: current!.expYear, status: 'REVOKED' }, paymentInProgress: false });
    const list = await card.listInstruments(p.userId, p.subId);
    expect(list.map((i) => i.status).sort()).toEqual(['REPLACED', 'REVOKED']);
    for (const i of list) expect(Object.keys(i).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'last4', 'status']);
    // Removing again is a no-op, and another partner cannot remove (or even see) it.
    expect(await card.removeInstrument({ userId: p.userId, instrumentId: current!.id })).toMatchObject({ card: { status: 'REVOKED' }, paymentInProgress: false });
    const stranger = await partner();
    await expect(card.removeInstrument({ userId: stranger.userId, instrumentId: old!.id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(card.listInstruments(stranger.userId, p.subId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('no enrolment without the weekly-charge consent; Decline adds nothing', async () => {
    const p = await partner();
    await expect(card.startSession({ userId: p.userId, subscriptionId: p.subId, purpose: 'ENROLL' })).rejects.toMatchObject({ code: 'CARD_CONSENT_REQUIRED' });
    await expect(card.startSession({ userId: p.userId, subscriptionId: p.subId, purpose: 'ENROLL', consentVersion: 'old' })).rejects.toMatchObject({ code: 'CARD_CONSENT_REQUIRED' });
    const session = await start(p, 'ENROLL');
    await returnWith(await press(session.sessionId, 'DECLINE'));
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'FAILED' });
    expect((await money(p.subId)).instruments).toHaveLength(0);
    expect((await money(p.subId)).sub.billingMethod).toBe('CASH');
  });

  it('a removal that names a subscription acts only on that subscription’s cards: another’s is not found there and stays ACTIVE', async () => {
    const p = await partner();
    const x = await enrolled(p);
    const elsewhere = await partner();
    await expect(card.removeInstrument({ userId: p.userId, instrumentId: x.id, subscriptionId: elsewhere.subId })).rejects.toMatchObject({ statusCode: 404 });
    expect((await money(p.subId)).instruments.map((i) => i.status), 'removed through a subscription it does not belong to').toEqual(['ACTIVE']);
    expect(await card.removeInstrument({ userId: p.userId, instrumentId: x.id, subscriptionId: p.subId })).toMatchObject({ card: { status: 'REVOKED' }, paymentInProgress: false });
  });
});

describe('[C5 · C8] a return is an observation: the wrong one grants nothing, and says why', () => {
  it('wrong state, wrong user, wrong purpose, a replay — each recorded with its reason; none enrols; the real return still works once', async () => {
    const p = await partner();
    const other = await partner();
    const session = await start(p, 'ENROLL');
    const back = await press(session.sessionId, 'APPROVE');
    expect(await returnWith(back, { state: 'forged-state-that-is-long-enough' })).toMatchObject({ accepted: false, verdict: 'REJECTED_STATE' });
    expect(await returnWith(back, { actorUserId: other.userId })).toMatchObject({ accepted: false, verdict: 'REJECTED_USER' });
    expect(await returnWith(back, { expectedPurpose: 'PAY_NOW' })).toMatchObject({ accepted: false, verdict: 'REJECTED_PURPOSE' });
    expect(await returnWith(back, { actorUserId: p.userId, expectedPurpose: 'ENROLL' })).toMatchObject({ accepted: true, verdict: 'ACCEPTED' });
    expect(await returnWith(back)).toMatchObject({ accepted: false, verdict: 'REJECTED_REPLAY' });
    expect((await money(p.subId)).instruments).toHaveLength(0);
    expect((await observations(session.sessionId)).map((o) => o.verdict)).toEqual([
      'REJECTED_STATE', 'REJECTED_USER', 'REJECTED_PURPOSE', 'ACCEPTED', 'REJECTED_REPLAY',
    ]);
    // Someone else cannot confirm it for the partner either.
    await expect(card.confirm(session.sessionId, { actorUserId: other.userId })).rejects.toMatchObject({ statusCode: 404 });
    expect(await card.confirm(session.sessionId, { actorUserId: p.userId })).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('an EXPIRED return is refused and grants nothing: the enrolment closes without a card', async () => {
    const p = await partner();
    const session = await start(p, 'ENROLL');
    const back = await press(session.sessionId, 'APPROVE');
    const late = new Date(Date.parse(session.expiresAt) + 60_000);
    expect(await returnWith(back, { now: late })).toMatchObject({ accepted: false, verdict: 'REJECTED_EXPIRED' });
    expect(await card.confirm(session.sessionId, { now: late })).toMatchObject({ status: 'EXPIRED' });
    expect((await money(p.subId)).instruments).toHaveLength(0);
    expect(await returnWith(back, { now: late })).toMatchObject({ accepted: false, verdict: 'REJECTED_CLOSED' });
  });

  it('WRONG TENANT: from another operator the session does not exist — nothing recorded, nothing confirmed, nothing opened', async () => {
    const p = await partner();
    const session = await start(p, 'ENROLL');
    const back = await press(session.sessionId, 'APPROVE');
    expect(await runWithTenant(OTHER_TENANT, () => returnWith(back))).toMatchObject({ accepted: false, verdict: 'UNKNOWN_SESSION' });
    await expect(runWithTenant(OTHER_TENANT, () => card.confirm(session.sessionId))).rejects.toMatchObject({ statusCode: 404 });
    await expect(runWithTenant(OTHER_TENANT, () => start(p, 'PAY_NOW'))).rejects.toMatchObject({ statusCode: 404 });
    expect(await observations(session.sessionId)).toEqual([]);
    expect((await money(p.subId)).instruments).toHaveLength(0);
  });

  it('an unknown session records nothing — the public return cannot be used to write rows', async () => {
    expect(await card.handleReturn({ sessionId: `nope-${RUN}`, state: 'x', params: {} })).toMatchObject({ accepted: false, verdict: 'UNKNOWN_SESSION' });
    expect(await app.prisma.cardObservation.count({ where: { sessionId: `nope-${RUN}` } })).toBe(0);
  });
});

describe('PAY_NOW: server-priced, booked ONCE through applySuccessfulCharge, which reinstates', () => {
  it('taxi activation after the delivery quote opens no stale-price page; retry uses the shared 8,000 fee', async () => {
    const p = await partner();
    const driver = await app.prisma.driver.create({ data: { userId: p.userId, vehicleType: 'CAR', vehicleMake: 'Test', vehicleModel: 'Fixture',
      vehicleYear: 2020, vehicleColor: 'White', licensePlate: `CARD-FEE-${RUN}-${seq}`, driverLicenseUrl: 'storage://test/license', vehicleInsuranceUrl: 'storage://test/insurance' } });
    const quote = billing.quoteCardPayNow.bind(billing);
    const interceptor = vi.spyOn(billing, 'quoteCardPayNow').mockImplementationOnce(async (...args) => {
      const old = await quote(...args);
      await new SubscriptionService(app.prisma).startTrialForDriver(driver.id);
      return old;
    });
    try {
      await expect(start(p, 'PAY_NOW')).rejects.toMatchObject({ code: 'MOVER_FEE_PRICE_CHANGED' });
      expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(0);
      const fresh = await start(p, 'PAY_NOW');
      expect(fresh.amount).toBe(8000);
      expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } })).type).toBe('DELIVERY_RIDER');
    } finally { interceptor.mockRestore(); }
  });
  it('a SUSPENDED partner pays the owed week by card: the week advances, access returns, one success, one ledger posting — and a second confirm books nothing', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const p = await partner({ status: 'SUSPENDED', due, failedAttempts: 3 });
    const session = await start(p, 'PAY_NOW');
    expect(session).toMatchObject({ purpose: 'PAY_NOW', amount: WEEKLY, currencyCode: 'GYD', testMode: true });
    await returnWith(await press(session.sessionId, 'APPROVE'));
    expect((await money(p.subId)).successes).toBe(0); // the return booked nothing
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', settlement: 'advanced' });
    const after = await money(p.subId);
    expect(after.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, suspendedAt: null });
    expect(after.sub.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect(after.successes).toBe(1);
    expect(after.ledger).toBe(1);
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ status: 'CAPTURED', paymentMethod: 'CARD', clientKey: `cardpay:${session.sessionId}`, externalRef: expect.stringMatching(/^simpay_/) });
    expect(Number(after.payments[0]!.amount)).toBe(WEEKLY);
    // [credit once] again, and again through the sweep: still one of everything.
    await card.confirm(session.sessionId);
    await card.sweepSessions(new Date(Date.parse(session.expiresAt) + 60_000));
    const again = await money(p.subId);
    expect([again.successes, again.ledger, again.payments.length, again.bank]).toEqual([1, 1, 1, 0]);
  });

  it('[capture-then-timeout] the first confirm loses the answer (nothing booked); the next finds the same capture — one payment, one success', async () => {
    const p = await partner({ status: 'PAST_DUE', due: new Date(Date.now() - DAY), failedAttempts: 1 });
    const session = await start(p, 'PAY_NOW');
    await returnWith(await press(session.sessionId, 'TIMEOUT'));
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'OPEN' });
    expect((await money(p.subId)).payments).toHaveLength(0);
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', settlement: 'advanced' });
    const after = await money(p.subId);
    expect([after.successes, after.ledger, after.payments.length]).toEqual([1, 1, 1]);
    expect(after.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect((await observations(session.sessionId)).map((o) => `${o.source}:${o.parsedStatus}`)).toEqual([
      'RETURN:UNKNOWN', 'CONFIRM:UNKNOWN', 'CONFIRM:SUCCEEDED',
    ]);
  });

  it('[credit once] the process dies after the payment row is written and before it is booked: the next confirm resumes THAT row — one payment, one week', async () => {
    const p = await partner({ status: 'PAST_DUE', due: new Date(Date.now() - DAY), failedAttempts: 1 });
    const session = await start(p, 'PAY_NOW');
    await returnWith(await press(session.sessionId, 'APPROVE'));
    // A billing engine that dies exactly once, at the booking step.
    let crash = true;
    const dying = Object.create(billing) as BillingService;
    dying.settleHostedCardPayment = async (input) => {
      if (crash) { crash = false; throw new Error('crash: after the payment row, before the booking'); }
      return billing.settleHostedCardPayment(input);
    };
    const svc = new CardRailService(app.prisma, notifications, dying, () => sim);
    await expect(svc.confirm(session.sessionId)).rejects.toThrow(/crash/);
    const mid = await money(p.subId);
    expect(mid.payments).toEqual([expect.objectContaining({ status: 'UNKNOWN', clientKey: `cardpay:${session.sessionId}` })]);
    expect(mid.successes).toBe(0);
    expect(await svc.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', settlement: 'advanced' });
    const after = await money(p.subId);
    expect([after.successes, after.ledger, after.payments.length, after.bank]).toEqual([1, 1, 1, 0]);
  });

  it('[credit once] confirmations racing (the return and the sweep) book the week once', async () => {
    const p = await partner({ status: 'PAST_DUE', due: new Date(Date.now() - DAY), failedAttempts: 1 });
    const session = await start(p, 'PAY_NOW');
    await returnWith(await press(session.sessionId, 'APPROVE'));
    const results = await Promise.all([card.confirm(session.sessionId), card.confirm(session.sessionId), cardWith(sim).confirm(session.sessionId)]);
    expect(results.map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    const after = await money(p.subId);
    expect([after.successes, after.ledger, after.payments.length, after.bank]).toEqual([1, 1, 1, 0]);
  });

  it('a decline books nothing and is not a strike', async () => {
    const p = await partner({ status: 'PAST_DUE', due: new Date(Date.now() - DAY), failedAttempts: 1 });
    const session = await start(p, 'PAY_NOW');
    await returnWith(await press(session.sessionId, 'DECLINE'));
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'FAILED' });
    const after = await money(p.subId);
    expect(after.payments).toHaveLength(0);
    expect(after.sub).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
  });

  it('nothing due: Pay now pays the NEXT week ahead (one week, server-priced)', async () => {
    const due = new Date(Date.now() + 4 * DAY);
    const p = await partner({ due });
    const session = await start(p, 'PAY_NOW');
    expect(session.amount).toBe(WEEKLY);
    await returnWith(await press(session.sessionId, 'APPROVE'));
    expect(await card.confirm(session.sessionId)).toMatchObject({ settlement: 'advanced' });
    expect((await money(p.subId)).sub.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
  });

  it('the return is lost after the bank took the money: the sweep past the window finds it and books it ONCE — money is never dropped', async () => {
    const p = await partner({ status: 'PAST_DUE', due: new Date(Date.now() - DAY), failedAttempts: 1 });
    const session = await start(p, 'PAY_NOW');
    await press(session.sessionId, 'APPROVE'); // the browser never comes back
    const late = new Date(Date.parse(session.expiresAt) + 60_000);
    const swept = await card.sweepSessions(late);
    expect(swept.succeeded).toBeGreaterThanOrEqual(1);
    await card.sweepSessions(late);
    const after = await money(p.subId);
    expect([after.successes, after.payments.length]).toEqual([1, 1]);
    expect(after.sub.status).toBe('ACTIVE');
  });

  it('an unanswered page remains UNKNOWN after local expiry, paused with nothing booked', async () => {
    const p = await partner();
    const session = await start(p, 'PAY_NOW');
    await card.sweepSessions(new Date(Date.parse(session.expiresAt) + 60_000));
    expect((await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status).toBe('UNKNOWN');
    expect((await money(p.subId)).sub.billingConfirmationPausedAt).not.toBeNull();
    expect((await money(p.subId)).payments).toHaveLength(0);
  });

  it('a provider figure that disagrees with the server’s price is HELD for a person — nothing booked', async () => {
    const p = await partner({ status: 'PAST_DUE', due: new Date(Date.now() - DAY), failedAttempts: 1 });
    // A provider that reports charging 100x the price (a minor-unit mistake).
    const misprices = new Proxy(sim, {
      get(target, prop, receiver) {
        if (prop === 'confirm') {
          return async (input: Parameters<CardRailProvider['confirm']>[0]) => {
            const answer = await target.confirm(input);
            return answer.status === 'succeeded' && answer.purpose === 'PAY_NOW' ? { ...answer, amountMinor: answer.amountMinor * 100 } : answer;
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const session = await start(p, 'PAY_NOW');
    await returnWith(await press(session.sessionId, 'APPROVE'));
    expect(await cardWith(misprices).confirm(session.sessionId)).toMatchObject({ status: 'HELD' });
    const after = await money(p.subId);
    expect([after.payments.length, after.successes]).toEqual([0, 0]);
    expect(after.sub).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
    expect((await observations(session.sessionId)).at(-1)).toMatchObject({ source: 'CONFIRM', verdict: 'REJECTED_MISMATCH' });
    const paged = await app.prisma.notification.count({ where: { data: { path: ['sessionId'], equals: session.sessionId } } });
    expect(paged).toBeGreaterThan(0);
  });
});

describe('[C6] one live session per purpose; a retry key answers the same session', () => {
  it('a second open enrolment is refused while the first is live; a Pay now may run beside it; the same key replays', async () => {
    const p = await partner();
    const first = await start(p, 'ENROLL', { idempotencyKey: `enroll-${RUN}-a` });
    await expect(start(p, 'ENROLL')).rejects.toMatchObject({ statusCode: 409, code: 'CARD_SESSION_OPEN' });
    expect(await start(p, 'ENROLL', { idempotencyKey: `enroll-${RUN}-a` })).toEqual(first);
    await expect(start(p, 'PAY_NOW')).resolves.toMatchObject({ purpose: 'PAY_NOW', status: 'OPEN' });
    await expect(start(p, 'ENROLL', { idempotencyKey: 'short' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
  });
});

describe('[C7] the kill switch and the flag stop NEW sessions only', () => {
  it('killed: no new session — yet an open one still confirms and the sweep still drains', async () => {
    const p = await partner({ status: 'PAST_DUE', due: new Date(Date.now() - DAY), failedAttempts: 1 });
    const session = await start(p, 'PAY_NOW');
    const back = await press(session.sessionId, 'APPROVE');
    process.env['CARD_RAIL_KILL'] = '1';
    await expect(start(p, 'ENROLL')).rejects.toMatchObject({ statusCode: 503, code: 'CARD_RAIL_DISABLED' });
    expect(await returnWith(back)).toMatchObject({ accepted: true });
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', settlement: 'advanced' });
  });

  it('flag OFF (the default): no session can be opened at all', async () => {
    const p = await partner();
    process.env['CARD_RAIL_V2'] = '';
    await expect(start(p, 'ENROLL')).rejects.toMatchObject({ statusCode: 404, code: 'CARD_RAIL_UNAVAILABLE' });
    await expect(start(p, 'PAY_NOW')).rejects.toMatchObject({ statusCode: 404, code: 'CARD_RAIL_UNAVAILABLE' });
  });

  it('a closed (CANCELLED) subscription cannot open a card session', async () => {
    const p = await partner({ status: 'CANCELLED' });
    await expect(start(p, 'PAY_NOW')).rejects.toMatchObject({ statusCode: 409, code: 'SUBSCRIPTION_CLOSED' });
  });
});

describe('[C2] a session belongs to the provider setup that opened it', () => {
  it('confirmed under another account, it is asked of nobody and grants nothing; admins are paged', async () => {
    const p = await partner();
    const session = await start(p, 'ENROLL');
    await returnWith(await press(session.sessionId, 'APPROVE'));
    const elsewhere = new SimulatorCardRailProvider(redis, { account: `pt1-${RUN}-elsewhere`, keyPrefix: PREFIX });
    expect(await cardWith(elsewhere).confirm(session.sessionId)).toMatchObject({ status: 'OPEN' });
    expect((await money(p.subId)).instruments).toHaveLength(0);
    const paged = await app.prisma.notification.count({ where: { data: { path: ['alert'], equals: 'card-session-binding-mismatch' } } });
    expect(paged).toBeGreaterThan(0);
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED' });
  });
});

// ---------------------------------------------------------------------------
// [AX297] Money review of PR #1375. Helpers shared by the race and currency
// suites below.
// ---------------------------------------------------------------------------

/** The partner adds a card through the real loop; the ACTIVE row, its token,
 *  and what the confirmation answered. */
async function enrolled(p: { userId: string; subId: string }, scenario: SimulatorScenario = 'APPROVE', svc: CardRailService = card) {
  const s = await svc.startSession({ userId: p.userId, subscriptionId: p.subId, purpose: 'ENROLL', consentVersion: CARD_ON_FILE_CONSENT_VERSION });
  await returnWith(await press(s.sessionId, scenario));
  const done = await svc.confirm(s.sessionId);
  const row = await app.prisma.paymentInstrument.findUniqueOrThrow({ where: { id: done.instrument!.id } });
  return { id: row.id, token: await openVaultToken(row), confirmed: done };
}

/** The simulator, watched: every instrument charge that reaches the provider.
 *  `hooks.beforeCharge` runs as a charge arrives, before the provider acts on it. */
function watched(inner: CardRailProvider, hooks: { beforeCharge?: () => Promise<void> } = {}) {
  const charges: Array<{ vaultToken: string; idempotencyKey: string }> = [];
  const provider: CardRailProvider = {
    binding: inner.binding,
    simulator: inner.simulator,
    savesCards: inner.savesCards,
    createSession: (i) => inner.createSession(i),
    parseReturn: (params) => inner.parseReturn(params),
    confirm: (i) => inner.confirm(i),
    chargeInstrument: async (i) => {
      await hooks.beforeCharge?.();
      charges.push({ vaultToken: i.vaultToken, idempotencyKey: i.idempotencyKey });
      return inner.chargeInstrument(i);
    },
    retrieve: (i) => inner.retrieve(i),
    refund: (i) => inner.refund(i),
  };
  return { provider, charges };
}

/** The subscription as the billing cycle loads it. */
const billable = async (subId: string) => (await app.prisma.subscription.findUniqueOrThrow({
  where: { id: subId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
})) as never;

const failureNotes = async (subId: string) =>
  (await app.prisma.billingEvent.findMany({ where: { subscriptionId: subId, type: 'CHARGE_FAILED' }, orderBy: { createdAt: 'asc' }, select: { note: true } })).map((e) => e.note);

/** [AX318 R1] Runs `fn` once, the moment phase one (authorization) has
 *  committed its AUTHORIZED intent and before phase two (the handoff). */
function afterAuthorization(billing: BillingService, fn: (intentId: string) => Promise<void>) {
  const target = billing as unknown as { authorizeInstrumentCharge: (...args: unknown[]) => Promise<{ outcome: string; intentId?: string }> };
  const original = target.authorizeInstrumentCharge.bind(billing);
  let ran = false;
  vi.spyOn(target, 'authorizeInstrumentCharge').mockImplementation(async (...args: unknown[]) => {
    const authorized = await original(...args);
    if (!ran && authorized.intentId) {
      ran = true;
      await fn(authorized.intentId);
    }
    return authorized;
  });
}

/** Past the reclaim window: the cycle takes a waiting attempt from the top. */
const pastReclaim = () => new Date(Date.now() + 31 * 60_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (!row) throw new Error('no backend pid');
  return row.pid;
}

/** A barrier with a deadline: an elapsed deadline fails, it never passes. */
async function reached(barrier: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([barrier, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error(`${label}: barrier not reached`)), 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** PostgreSQL's own word that one backend waits on another. Polled; an elapsed
 *  deadline is a failure, never evidence of blocking. */
async function provenBlocked(waiter: () => number, holder: () => number, label: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (waiter() && holder()) {
      const [row] = await app.prisma.$queryRaw<Array<{ blockers: number[] }>>`SELECT pg_blocking_pids(${waiter()}::integer) AS blockers`;
      if (row?.blockers.includes(holder())) return;
    }
    if (Date.now() > deadline) throw new Error(`${label}: not proven blocked`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('[AX297 F1] a card that leaves service after billing read it is never charged', () => {
  it('REMOVED between billing reading it ACTIVE and the charge being authorized: never charged, nobody penalised; the attempt waits, and the next cycle bills whatever card is on file then', async () => {
    const due = new Date(Date.now() - DAY);
    const p = await partner({ due });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    let removed = false;
    const removeOnce = async () => {
      if (removed) return;
      removed = true;
      await card.removeInstrument({ userId: p.userId, instrumentId: x.id });
    };
    // Both seams sit at the same point of the race: after the cycle read the card
    // ACTIVE, before the charge was authorized. (The pre-fix code offers the
    // first; the fixed code the second.)
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {
      beforeProviderEffectAuthorization: removeOnce,
      beforeInstrumentChargeAuthorization: removeOnce,
    } as BillingObserver, () => provider);

    const outcome = await racing.billSubscription(await billable(p.subId));
    expect(removed).toBe(true);
    expect(charges, 'the REMOVED card was charged').toEqual([]);
    expect(outcome).toBe('pending');
    const after = await money(p.subId);
    expect(after.instruments.map((i) => [i.id, i.status])).toEqual([[x.id, 'REVOKED']]);
    expect(after.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(after.sub.nextBillingDate.getTime()).toBe(due.getTime());
    // No intent was created for the removed card, and nothing counts against the partner.
    expect(after.payments).toEqual([]);
    expect([after.successes, (await failureNotes(p.subId)).length]).toEqual([0, 0]);

    // Not stuck: past the reclaim window the next cycle bills the card on file
    // then. There is none, which is the ordinary "no card" outcome for a partner
    // who removed their card; the removed card is still never charged.
    expect(await racing.billSubscription(await billable(p.subId), pastReclaim())).toBe('failed');
    expect(charges).toEqual([]);
    expect(await failureNotes(p.subId)).toEqual([expect.stringMatching(/^There is no card on file/)]);
  });

  it('REPLACED in the same window: the old card is never charged; the next cycle charges the NEW card, once', async () => {
    const due = new Date(Date.now() - DAY);
    const p = await partner({ due });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    let y: { id: string; token: string } | undefined;
    const replaceOnce = async () => {
      if (y) return;
      y = await enrolled(p, 'APPROVE');
    };
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {
      beforeProviderEffectAuthorization: replaceOnce,
      beforeInstrumentChargeAuthorization: replaceOnce,
    } as BillingObserver, () => provider);

    const outcome = await racing.billSubscription(await billable(p.subId));
    expect(y).toBeDefined();
    expect(charges.map((c) => c.vaultToken), 'the REPLACED card was charged').not.toContain(x.token);
    expect(charges).toEqual([]);
    expect(outcome).toBe('pending');
    let after = await money(p.subId);
    expect(after.instruments.map((i) => [i.id, i.status])).toEqual([[x.id, 'REPLACED'], [y!.id, 'ACTIVE']]);
    expect([after.payments.length, after.successes, (await failureNotes(p.subId)).length]).toEqual([0, 0, 0]);

    expect(await racing.billSubscription(await billable(p.subId), pastReclaim())).toBe('succeeded');
    expect(charges.map((c) => c.vaultToken)).toEqual([y!.token]);
    after = await money(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'CAPTURED', instrumentId: y!.id })]);
    expect([after.successes, after.ledger]).toEqual([1, 1]);
    expect(after.sub.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
  });

  it('[lock order] the REMOVAL holds payer, subscription and card: the charge authorization waits on it, then sees REVOKED; never charged, no deadlock', async () => {
    const p = await partner({ due: new Date(Date.now() - DAY) });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    const billingRead = deferred(); const releaseBilling = deferred();
    const removalHolds = deferred(); const releaseRemoval = deferred();
    let billingPid = 0; let removalPid = 0;
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {
      beforeInstrumentChargeAuthorization: async () => { billingRead.resolve(); await releaseBilling.promise; billingPid = 0; },
      beforeLateMmgAuthorityLock: async (subscriptionId, tx) => { if (subscriptionId === p.subId && !billingPid) billingPid = await backendPid(tx); },
    }, () => provider);
    const cards = new CardRailService(app.prisma, notifications, racing, () => provider, {
      observer: { afterCardLocked: async (_s, tx) => { removalPid = await backendPid(tx); removalHolds.resolve(); await releaseRemoval.promise; } },
    });

    const bill = racing.billSubscription(await billable(p.subId));
    let removal: Promise<unknown> | undefined;
    try {
      await reached(billingRead.promise, 'billing read the card ACTIVE');
      removal = cards.removeInstrument({ userId: p.userId, instrumentId: x.id });
      await reached(removalHolds.promise, 'the removal holds its locks');
      releaseBilling.resolve();
      await provenBlocked(() => billingPid, () => removalPid, 'the charge authorization');
    } finally {
      releaseBilling.resolve();
      releaseRemoval.resolve();
      await Promise.allSettled([bill, ...(removal ? [removal] : [])]);
    }
    const outcomes = await Promise.allSettled([bill, removal!]);
    expect(outcomes.map((o) => o.status), JSON.stringify(outcomes.map((o) => (o.status === 'rejected' ? String(o.reason) : 'ok')))).toEqual(['fulfilled', 'fulfilled']);
    expect(charges, 'the REMOVED card was charged').toEqual([]);
    expect((outcomes[0] as PromiseFulfilledResult<string>).value).toBe('pending');
    const after = await money(p.subId);
    expect(after.instruments.map((i) => i.status)).toEqual(['REVOKED']);
    expect([after.payments.length, after.successes, (await failureNotes(p.subId)).length, after.sub.failedAttempts]).toEqual([0, 0, 0, 0]);
  });

  it('[lock order] a REPLACEMENT holds the old card: the authorization waits, then sees REPLACED; only the new card is ever charged', async () => {
    const due = new Date(Date.now() - DAY);
    const p = await partner({ due });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    const billingRead = deferred(); const releaseBilling = deferred();
    const replacementHolds = deferred(); const releaseReplacement = deferred();
    let billingPid = 0; let replacementPid = 0;
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {
      beforeInstrumentChargeAuthorization: async () => { billingRead.resolve(); await releaseBilling.promise; billingPid = 0; },
      beforeLateMmgAuthorityLock: async (subscriptionId, tx) => { if (subscriptionId === p.subId && !billingPid) billingPid = await backendPid(tx); },
    }, () => provider);
    const cards = new CardRailService(app.prisma, notifications, racing, () => provider, {
      observer: { afterCardLocked: async (_s, tx) => { replacementPid = await backendPid(tx); replacementHolds.resolve(); await releaseReplacement.promise; } },
    });
    const next = await cards.startSession({ userId: p.userId, subscriptionId: p.subId, purpose: 'ENROLL', consentVersion: CARD_ON_FILE_CONSENT_VERSION });
    await returnWith(await press(next.sessionId, 'APPROVE'));

    const bill = racing.billSubscription(await billable(p.subId));
    let replace: Promise<unknown> | undefined;
    try {
      await reached(billingRead.promise, 'billing read the card ACTIVE');
      replace = cards.confirm(next.sessionId);
      await reached(replacementHolds.promise, 'the replacement holds its locks');
      releaseBilling.resolve();
      await provenBlocked(() => billingPid, () => replacementPid, 'the charge authorization');
    } finally {
      releaseBilling.resolve();
      releaseReplacement.resolve();
      await Promise.allSettled([bill, ...(replace ? [replace] : [])]);
    }
    const outcomes = await Promise.allSettled([bill, replace!]);
    expect(outcomes.map((o) => o.status), JSON.stringify(outcomes.map((o) => (o.status === 'rejected' ? String(o.reason) : 'ok')))).toEqual(['fulfilled', 'fulfilled']);
    expect(charges, 'the REPLACED card was charged').toEqual([]);
    const [old, current] = (await money(p.subId)).instruments;
    expect([old!.id, old!.status, current!.status]).toEqual([x.id, 'REPLACED', 'ACTIVE']);

    expect(await racing.billSubscription(await billable(p.subId), pastReclaim())).toBe('succeeded');
    expect(charges.map((c) => c.vaultToken)).toEqual([await openVaultToken(current!)]);
    expect((await money(p.subId)).sub.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
  });

  it('[lock order] the AUTHORIZATION holds the card: a removal waits for it, then wins at the handoff: the authorized charge closes NOT_SENT and nothing is sent [AX318 R1]', async () => {
    const due = new Date(Date.now() - DAY);
    const p = await partner({ due });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    const billingHolds = deferred(); const releaseBilling = deferred(); const removalArrived = deferred();
    let billingPid = 0; let removalPid = 0;
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {
      afterInstrumentChargeLocked: async (_s, _i, tx) => { billingPid = await backendPid(tx); billingHolds.resolve(); await releaseBilling.promise; },
    }, () => provider);
    const cards = new CardRailService(app.prisma, notifications, racing, () => provider, {
      observer: { beforeCardLocks: async (_s, tx) => { removalPid = await backendPid(tx); removalArrived.resolve(); } },
    });

    const bill = racing.billSubscription(await billable(p.subId));
    let removal: Promise<unknown> | undefined;
    try {
      await reached(billingHolds.promise, 'the authorization holds the card');
      removal = cards.removeInstrument({ userId: p.userId, instrumentId: x.id });
      await reached(removalArrived.promise, 'the removal arrived');
      await provenBlocked(() => removalPid, () => billingPid, 'the removal');
    } finally {
      releaseBilling.resolve();
      await Promise.allSettled([bill, ...(removal ? [removal] : [])]);
    }
    const outcomes = await Promise.allSettled([bill, removal!]);
    expect(outcomes.map((o) => o.status), JSON.stringify(outcomes.map((o) => (o.status === 'rejected' ? String(o.reason) : 'ok')))).toEqual(['fulfilled', 'fulfilled']);
    // The removal queued behind phase one takes the locks the moment it
    // commits, before the handoff can: the authorized charge is closed, never sent.
    expect(charges, 'the REMOVED card was charged').toEqual([]);
    expect((outcomes[0] as PromiseFulfilledResult<string>).value).toBe('pending');
    expect((outcomes[1] as PromiseFulfilledResult<unknown>).value).toMatchObject({ card: { status: 'REVOKED' }, paymentInProgress: false });
    const after = await money(p.subId);
    expect(after.instruments.map((i) => i.status)).toEqual(['REVOKED']);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', clientKey: expect.stringContaining(':void:') })]);
    expect([after.successes, (await failureNotes(p.subId)).length, after.sub.failedAttempts]).toEqual([0, 0, 0]);
    expect(after.sub.nextBillingDate.getTime()).toBe(due.getTime());
  });
});

describe('[AX318 R1] the charge is handed to the provider only by a compare-and-set under the card lock', () => {
  it('REMOVED after the charge was authorized and before it was handed off: never charged; the removal closes the authorized charge NOT_SENT and the attempt is billed again from the top', async () => {
    const p = await partner({ due: new Date(Date.now() - DAY) });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {}, () => provider);
    const cards = new CardRailService(app.prisma, notifications, racing, () => provider);
    let removal: unknown;
    let intentAfterRemoval: SubscriptionPayment | null = null;
    afterAuthorization(racing, async (intentId) => {
      removal = await cards.removeInstrument({ userId: p.userId, instrumentId: x.id });
      intentAfterRemoval = await app.prisma.subscriptionPayment.findUnique({ where: { id: intentId } });
    });

    const outcome = await racing.billSubscription(await billable(p.subId));
    expect(charges, 'the REMOVED card was charged').toEqual([]);
    expect(removal).toMatchObject({ card: { status: 'REVOKED' }, paymentInProgress: false });
    expect(intentAfterRemoval, 'the removal left the authorized charge open').toMatchObject({
      status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', clientKey: expect.stringContaining(':void:'),
      failureRaw: expect.objectContaining({ providerEffect: 'NOT_SENT', cancelledBy: 'CARD_REMOVED' }),
    });
    expect(outcome).toBe('pending');
    const after = await money(p.subId);
    expect([after.successes, (await failureNotes(p.subId)).length, after.sub.failedAttempts]).toEqual([0, 0, 0]);
    // Not stuck on the closed charge's key: the next cycle bills the card on file (none: the ordinary outcome).
    expect(await racing.billSubscription(await billable(p.subId), pastReclaim())).toBe('failed');
    expect(charges).toEqual([]);
  });

  it('REMOVED after the charge was handed off: it is in flight, so that one charge finishes, exactly once, and the removal says a payment is in progress', async () => {
    const due = new Date(Date.now() - DAY);
    const p = await partner({ due });
    const x = await enrolled(p);
    let cards: CardRailService | undefined;
    let removal: unknown;
    const { provider, charges } = watched(sim, {
      beforeCharge: async () => { if (!removal) removal = await cards!.removeInstrument({ userId: p.userId, instrumentId: x.id }); },
    });
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {}, () => provider);
    cards = new CardRailService(app.prisma, notifications, racing, () => provider);

    expect(await racing.billSubscription(await billable(p.subId))).toBe('succeeded');
    expect(removal, 'the removal did not report the charge in flight').toMatchObject({ card: { status: 'REVOKED' }, paymentInProgress: true });
    expect(charges.map((c) => c.vaultToken)).toEqual([x.token]);
    const after = await money(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'CAPTURED', instrumentId: x.id })]);
    expect([after.successes, after.ledger]).toEqual([1, 1]);
    expect(after.sub.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect(after.instruments.map((i) => i.status)).toEqual(['REVOKED']);
  });

  it('the card leaves service between authorization and handoff by ANY path (here another run retires it as expired): the handoff re-checks it under the lock and sends nothing', async () => {
    const p = await partner({ due: new Date(Date.now() - DAY) });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {}, () => provider);
    afterAuthorization(racing, async () => {
      await app.prisma.paymentInstrument.updateMany({ where: { id: x.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', expiredAt: new Date() } });
    });

    expect(await racing.billSubscription(await billable(p.subId))).toBe('pending');
    expect(charges, 'a card that left service was charged').toEqual([]);
    expect((await money(p.subId)).payments).toEqual([expect.objectContaining({
      status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', clientKey: expect.stringContaining(':void:'),
      failureRaw: expect.objectContaining({ providerEffect: 'NOT_SENT', cancelledBy: 'CARD_OUT_OF_SERVICE' }),
    })]);
  });

  it('an authorization that aborts (a deadlock victim, a lost connection) leaves no intent and sends nothing; the attempt is billed again later, once', async () => {
    const p = await partner({ due: new Date(Date.now() - DAY) });
    const x = await enrolled(p);
    const { provider, charges } = watched(sim);
    let aborted = false;
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {
      afterInstrumentChargeLocked: async () => {
        if (aborted) return;
        aborted = true;
        throw Object.assign(new Error('deadlock detected (a simulated abort of the authorization transaction)'), { code: '40P01' });
      },
    }, () => provider);

    await expect(racing.billSubscription(await billable(p.subId))).rejects.toThrow(/deadlock detected/);
    expect(charges).toEqual([]);
    expect((await money(p.subId)).payments).toEqual([]);
    expect(await racing.billSubscription(await billable(p.subId), pastReclaim())).toBe('succeeded');
    expect(charges.map((c) => c.vaultToken)).toEqual([x.token]);
  });

  it('REPLACED after the charge was authorized and before it was handed off: the old card is never charged; the replacement closes the authorized charge NOT_SENT, reports nothing in progress, and the attempt is billed once, on the new card', async () => {
    const p = await partner({ due: new Date(Date.now() - DAY) });
    await enrolled(p);
    const { provider, charges } = watched(sim);
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {}, () => provider);
    let freshToken = '';
    let replacement: unknown;
    let intentAfterReplacement: SubscriptionPayment | null = null;
    afterAuthorization(racing, async (intentId) => {
      const fresh = await enrolled(p);
      freshToken = fresh.token;
      replacement = fresh.confirmed;
      intentAfterReplacement = await app.prisma.subscriptionPayment.findUnique({ where: { id: intentId } });
    });

    expect(await racing.billSubscription(await billable(p.subId))).toBe('pending');
    expect(charges, 'the REPLACED card was charged').toEqual([]);
    expect(intentAfterReplacement, 'the replacement left the authorized charge open').toMatchObject({
      status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', clientKey: expect.stringContaining(':void:'),
      failureRaw: expect.objectContaining({ providerEffect: 'NOT_SENT', cancelledBy: 'CARD_REPLACED' }),
    });
    expect(replacement).toMatchObject({ purpose: 'ENROLL', status: 'SUCCEEDED' });
    expect(replacement, 'a charge that was never sent was reported as in progress').not.toHaveProperty('paymentInProgress');
    const mid = await money(p.subId);
    expect([mid.successes, (await failureNotes(p.subId)).length, mid.sub.failedAttempts]).toEqual([0, 0, 0]);
    expect(await racing.billSubscription(await billable(p.subId), pastReclaim())).toBe('succeeded');
    expect(charges.map((c) => c.vaultToken), 'not billed once, on the new card').toEqual([freshToken]);
  });

  it('REPLACED after the charge was handed off: that one charge finishes on the replaced card, exactly once, and the new card’s confirmation says a payment is in progress', async () => {
    const due = new Date(Date.now() - DAY);
    const p = await partner({ due });
    const x = await enrolled(p);
    let replacement: unknown;
    const { provider, charges } = watched(sim, {
      beforeCharge: async () => { if (!replacement) replacement = (await enrolled(p)).confirmed; },
    });
    const racing = new BillingService(app.prisma, notifications, new SandboxPaymentProvider(), {}, () => provider);

    expect(await racing.billSubscription(await billable(p.subId))).toBe('succeeded');
    expect(replacement, 'the replacement did not report the charge in flight').toMatchObject({ purpose: 'ENROLL', status: 'SUCCEEDED', paymentInProgress: true });
    expect(charges.map((c) => c.vaultToken)).toEqual([x.token]);
    const after = await money(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'CAPTURED', instrumentId: x.id })]);
    expect([after.successes, after.ledger]).toEqual([1, 1]);
    expect(after.sub.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect(after.instruments.map((i) => i.status)).toEqual(['REPLACED', 'ACTIVE']);
  });
});

describe('[AX297 F2] a Pay now is booked in the currency its session was priced in, never the subscription’s current one', () => {
  it('re-denominated after the page opened: the owed week is booked in the SESSION currency (GYD), not relabelled USD', async () => {
    const due = new Date(Date.now() - 10 * DAY);
    const p = await partner({ status: 'SUSPENDED', due, failedAttempts: 3 });
    const session = await start(p, 'PAY_NOW');
    expect(session).toMatchObject({ amount: WEEKLY, currencyCode: 'GYD' });
    await returnWith(await press(session.sessionId, 'APPROVE'));
    await app.prisma.subscription.update({ where: { id: p.subId }, data: { currencyCode: 'USD' } });

    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', settlement: 'advanced' });
    const success = await app.prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: p.subId, type: 'CHARGE_SUCCESS' } });
    expect(success.currencyCode, 'the GYD capture was relabelled').toBe('GYD');
    expect(Number(success.amount)).toBe(WEEKLY);
    const after = await money(p.subId);
    expect(after.sub.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect([after.successes, after.ledger, after.bank]).toEqual([1, 1, 0]);
  });

  it('closed and re-denominated: the capture is banked in the SESSION currency (a new wallet opens in GYD), never USD', async () => {
    const p = await partner({ due: new Date(Date.now() - DAY) });
    const session = await start(p, 'PAY_NOW');
    await returnWith(await press(session.sessionId, 'APPROVE'));
    await app.prisma.subscription.update({ where: { id: p.subId }, data: { status: 'CANCELLED', autoRenew: false, currencyCode: 'USD' } });

    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED', settlement: 'banked' });
    const wallet = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: p.subId } });
    expect(wallet.currencyCode, 'the GYD capture was banked as USD').toBe('GYD');
    expect(Number(wallet.balance)).toBe(WEEKLY);
    const bank = await app.prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: p.subId, idempotencyKey: { startsWith: 'bank:' } } });
    expect(bank.currencyCode).toBe('GYD');
    expect((await money(p.subId)).successes).toBe(0);
  });

  it('a wallet that already holds another currency HOLDS the capture for a person: nothing banked, nothing relabelled', async () => {
    const p = await partner({ due: new Date(Date.now() - DAY) });
    const session = await start(p, 'PAY_NOW');
    await returnWith(await press(session.sessionId, 'APPROVE'));
    await app.prisma.subscription.update({ where: { id: p.subId }, data: { status: 'CANCELLED', autoRenew: false, currencyCode: 'USD' } });
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: p.subId, balance: 0, currencyCode: 'USD' } });

    expect(await card.confirm(session.sessionId), 'the GYD capture entered a USD wallet').toMatchObject({ status: 'HELD' });
    const after = await money(p.subId);
    expect([after.bank, after.successes]).toEqual([0, 0]);
    expect(Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: p.subId } })).balance)).toBe(0);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'UNKNOWN', failureCode: 'WALLET_CURRENCY_MISMATCH', externalRef: expect.stringMatching(/^simpay_/) })]);
    expect(await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).toMatchObject({ status: 'HELD', failureCode: 'WALLET_CURRENCY_MISMATCH' });
  });
});

describe('[AX297 F5] CARD_RAIL_V2 off: the worker sweep is a strict no-op; CARD_RAIL_V2_DRAIN=1 drains', () => {
  it('flag off: an expired page stays exactly as it was (no card service, no provider, no sweep); DRAIN=1 closes it', async () => {
    const p = await partner();
    const session = await start(p, 'ENROLL'); // opened while v2 was on
    const later = new Date(Date.parse(session.expiresAt) + 60_000);
    const before = await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } });
    const off = { NODE_ENV: 'development', CARD_RAIL_V2: '0' };
    expect(await sweepCardSessions({ prisma: app.prisma, notifications, billing, cardRail: cardRailWorkerSource({ redis }, off) }, later)).toBeNull();
    expect(await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).toEqual(before);

    const drain = { ...off, CARD_RAIL_V2_DRAIN: '1', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_ACCOUNT: `pt1-${RUN}` };
    const swept = await sweepCardSessions({ prisma: app.prisma, notifications, billing, cardRail: cardRailWorkerSource({ redis }, drain) }, later);
    expect(swept?.checked).toBeGreaterThanOrEqual(1);
    expect(await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).toMatchObject({ status: 'EXPIRED', failureCode: 'EXPIRED_UNUSED' });
  });
});

describe('shared confirmation authority fences card PAY_NOW', () => {
  async function pendingMmg(p: Awaited<ReturnType<typeof partner>>) {
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: p.subId } });
    return app.prisma.subscriptionPayment.create({ data: {
      subscriptionId: p.subId, amount: WEEKLY, paymentMethod: 'MOBILE_MONEY', status: 'PENDING',
      externalRef: `synthetic-held-${nanoid(12)}`, clientKey: `synthetic-mmg-${nanoid(12)}`,
      periodStart: sub.nextBillingDate, periodEnd: new Date(+sub.nextBillingDate + 7 * DAY),
      failureRaw: { providerEffect: 'AUTHORIZED' },
    } });
  }
  it('MMG uncertainty committed after quote prevents a second provider page reservation', async () => {
    const p = await partner();
    const quote = billing.quoteCardPayNow.bind(billing);
    const observer = vi.spyOn(billing, 'quoteCardPayNow').mockImplementationOnce(async (...args) => {
      const priced = await quote(...args); await pendingMmg(p); return priced;
    });
    const create = vi.spyOn(sim, 'createSession');
    try {
      await expect(start(p, 'PAY_NOW')).rejects.toMatchObject({ code: 'PAYMENT_CONFIRMING' });
      expect(create).not.toHaveBeenCalled();
      expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(0);
      expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId, status: 'ACTIVE' } })).toBe(1);
    } finally { observer.mockRestore(); create.mockRestore(); }
  });

  it('MMG uncertainty during provider creation preserves the session evidence but suppresses the hosted URL and replay', async () => {
    const p = await partner();
    const idempotencyKey = `handoff-${nanoid(12)}`;
    const create = sim.createSession.bind(sim);
    const observer = vi.spyOn(sim, 'createSession').mockImplementationOnce(async (...args) => {
      const answer = await create(...args); await pendingMmg(p); return answer;
    });
    try {
      await expect(start(p, 'PAY_NOW', { idempotencyKey })).rejects.toMatchObject({ code: 'PAYMENT_CONFIRMING' });
      const rows = await app.prisma.cardSession.findMany({ where: { subscriptionId: p.subId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: 'PAY_NOW', status: 'OPEN', idempotencyKey });
      expect(rows[0]!.providerSessionRef).toBeTruthy();
      expect(rows[0]!.hostedUrl).toBeTruthy();
      await expect(start(p, 'PAY_NOW', { idempotencyKey })).rejects.toMatchObject({ code: 'PAYMENT_CONFIRMING' });
      expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(1);
      expect(observer).toHaveBeenCalledOnce();
      expect(await app.prisma.paymentConfirmationHold.count({ where: { subscriptionId: p.subId, status: 'ACTIVE' } })).toBe(2);
    } finally { observer.mockRestore(); }
  });

  it('a saved PAY_NOW key cannot bypass a later cross-rail hold', async () => {
    const p = await partner();
    const idempotencyKey = `replay-${nanoid(12)}`;
    const first = await start(p, 'PAY_NOW', { idempotencyKey });
    await pendingMmg(p);
    await expect(start(p, 'PAY_NOW', { idempotencyKey })).rejects.toMatchObject({ code: 'PAYMENT_CONFIRMING' });
    expect(await app.prisma.cardSession.findUniqueOrThrow({ where: { id: first.sessionId } }))
      .toMatchObject({ idempotencyKey, status: 'OPEN', providerSessionRef: expect.any(String) });
    expect(await app.prisma.cardSession.count({ where: { subscriptionId: p.subId } })).toBe(1);
  });
});
