import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { CARD_ON_FILE_CONSENT_VERSION, CARD_SESSION_TTL_MS, CardRailService } from '../modules/billing/card-rail.service';
import { openVaultToken } from '../modules/billing/card-vault';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxPaymentProvider } from '../providers/payment/payment-provider';
import { SimulatorCardRailProvider, type SimulatorScenario } from '../providers/card/simulator-provider';
import type { CardRailProvider } from '../providers/card/card-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';

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
  sim = new SimulatorCardRailProvider(redis, { account: `pt1-${RUN}` });
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
  delete process.env['CARD_RAIL_V2'];
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  // Deleting the subscriptions cascades their cards, sessions and payments;
  // observations are append-only evidence and stay, keyed to this run's ids.
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await runWithoutTenant(async () => {
    await app.prisma.tenant.updateMany({ where: { id: OTHER_TENANT }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
  }, 'pt1-card-test');
  const keys = await redis.keys('cardsim:*');
  if (keys.length > 0) await redis.del(...keys);
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
    expect(removed).toEqual({ id: current!.id, brand: 'SIMULATED', last4: '3155', expMonth: 12, expYear: current!.expYear, status: 'REVOKED' });
    const list = await card.listInstruments(p.userId, p.subId);
    expect(list.map((i) => i.status).sort()).toEqual(['REPLACED', 'REVOKED']);
    for (const i of list) expect(Object.keys(i).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'last4', 'status']);
    // Removing again is a no-op, and another partner cannot remove (or even see) it.
    expect(await card.removeInstrument({ userId: p.userId, instrumentId: current!.id })).toMatchObject({ status: 'REVOKED' });
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

  it('an abandoned page (no button pressed) expires in the sweep and books nothing', async () => {
    const p = await partner();
    const session = await start(p, 'PAY_NOW');
    await card.sweepSessions(new Date(Date.parse(session.expiresAt) + 60_000));
    expect((await app.prisma.cardSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status).toBe('EXPIRED');
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
    const elsewhere = new SimulatorCardRailProvider(redis, { account: `pt1-${RUN}-elsewhere` });
    expect(await cardWith(elsewhere).confirm(session.sessionId)).toMatchObject({ status: 'OPEN' });
    expect((await money(p.subId)).instruments).toHaveLength(0);
    const paged = await app.prisma.notification.count({ where: { data: { path: ['alert'], equals: 'card-session-binding-mismatch' } } });
    expect(paged).toBeGreaterThan(0);
    expect(await card.confirm(session.sessionId)).toMatchObject({ status: 'SUCCEEDED' });
  });
});
