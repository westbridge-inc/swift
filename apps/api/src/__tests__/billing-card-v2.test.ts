import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService, type BillingObserver } from '../modules/billing/billing.service';
import { sealVaultToken } from '../modules/billing/card-vault';
import { NotificationService } from '../modules/notification/notification.service';
import type { ChargeLookup, ChargeResult, PaymentProvider } from '../providers/payment/payment-provider';
import {
  assertBinding, rawDigest,
  type CardChargeOutcome, type CardRailBinding, type CardRailProvider, type CardRefundOutcome, type CardReturnObservation,
  type CardSessionOutcome, type CreateCardSessionOutcome,
} from '../providers/card/card-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { cardRailWorkerSource } from '../modules/billing/card-rail-worker';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [PT-1] The weekly fee on an enrolled card (CARD_RAIL_V2=1). The charge uses
// the ACTIVE instrument through the provider RECORDED ON IT, and every law of
// the card path holds: intent before effect, one capture per key, retrieve
// before retry, UNKNOWN is not a decline, the kill switch stops new
// instructions only. Added: requires_action is not a strike [C4]; a token is
// never sent to another provider setup [C2]; expired / replaced / revoked
// cards never charge; a capture reporting another amount is held, never
// booked; and the legacy sub.paymentToken is never read.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const PHONE = `+59200743${String(Date.now()).slice(-4)}`;
const BINDING: CardRailBinding = { provider: 'fakebank', environment: 'sandbox', account: `pt1-v2-${RUN}` };
const LEGACY_SENTINEL = 'tok_legacy_must_never_be_sent';
const WEEKLY = 12000;
const MINOR = 1_200_000;
let app: FastifyInstance;
let billing: BillingService;
let fake: FakeCardRail;
let legacy: LegacySpy;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

/** A processor double with the two properties the laws need: it records a
 *  capture the instant it happens (whatever it answers), and one key never
 *  captures twice. */
class FakeCardRail implements CardRailProvider {
  readonly simulator = false;
  readonly savesCards = true;
  mode: 'ok' | 'decline' | 'requires_action' | 'capture-then-timeout' | 'misprice' = 'ok';
  readonly charges: Array<{ vaultToken: string; binding: CardRailBinding; idempotencyKey: string; amountMinor: number; currencyCode: string }> = [];
  readonly retrieves: string[] = [];
  readonly captures = new Map<string, { providerRef: string; amountMinor: number; currencyCode: string }>();
  constructor(readonly binding: CardRailBinding) {}
  async createSession(): Promise<CreateCardSessionOutcome> { return { status: 'failed', reason: 'not used here', rawSha256: rawDigest('n/a') }; }
  parseReturn(params: Readonly<Record<string, string>>): CardReturnObservation { return { rawSha256: rawDigest(params), claimedStatus: 'invalid' }; }
  async confirm(): Promise<CardSessionOutcome> { return { status: 'unknown', reason: 'not used here', rawSha256: rawDigest('n/a') }; }
  async chargeInstrument(input: Parameters<CardRailProvider['chargeInstrument']>[0]): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    this.charges.push({ vaultToken: input.vaultToken, binding: input.binding, idempotencyKey: input.idempotencyKey, amountMinor: input.amountMinor, currencyCode: input.currencyCode });
    const rawSha256 = rawDigest({ key: input.idempotencyKey });
    const seen = this.captures.get(input.idempotencyKey);
    if (seen) return { status: 'succeeded', ...seen, rawSha256 };
    const capture = { providerRef: `fk_${nanoid(8)}`, amountMinor: input.amountMinor, currencyCode: input.currencyCode };
    switch (this.mode) {
      case 'decline': return { status: 'failed', reason: 'Card declined', rawSha256 };
      case 'requires_action': return { status: 'requires_action', reason: 'The bank asks the cardholder to authenticate', rawSha256 };
      case 'capture-then-timeout': this.captures.set(input.idempotencyKey, capture); return { status: 'unknown', reason: 'Gateway timeout', rawSha256 };
      case 'misprice': {
        const wrong = { ...capture, amountMinor: input.amountMinor * 100 };
        this.captures.set(input.idempotencyKey, wrong);
        return { status: 'succeeded', ...wrong, rawSha256 };
      }
      default: this.captures.set(input.idempotencyKey, capture); return { status: 'succeeded', ...capture, rawSha256 };
    }
  }
  async retrieve(input: { binding: CardRailBinding; idempotencyKey: string }): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    this.retrieves.push(input.idempotencyKey);
    const seen = this.captures.get(input.idempotencyKey);
    const rawSha256 = rawDigest({ retrieve: input.idempotencyKey });
    return seen ? { status: 'succeeded', ...seen, rawSha256 } : { status: 'unknown', reason: 'no such key', absent: true, rawSha256 };
  }
  async refund(): Promise<CardRefundOutcome> { return { status: 'pending', rawSha256: rawDigest('refund') }; }
}

/** The legacy seam, watched: v2 must never reach it for a v2 charge. */
class LegacySpy implements PaymentProvider {
  calls: string[] = [];
  async tokenizeCard(): Promise<{ token: string }> { this.calls.push('tokenizeCard'); return { token: 'x' }; }
  async chargeToken(input: { token: string }): Promise<ChargeResult> { this.calls.push(`chargeToken:${input.token}`); return { status: 'failed', providerRef: '', reason: 'legacy must not run' }; }
  async refund(): Promise<ChargeResult> { this.calls.push('refund'); return { status: 'failed', providerRef: '' }; }
  async lookupCharge(): Promise<ChargeLookup> { this.calls.push('lookupCharge'); return { status: 'unknown', reason: 'legacy lookup' }; }
}

let armed = false;
const observer: BillingObserver = {
  afterProviderReturned: async () => {
    if (!armed) return;
    armed = false;
    throw new Error('failpoint: the process died after the processor answered, before any local write');
  },
};

async function cardSub(opts: { due?: Date; status?: SubscriptionStatus; paymentToken?: string | null; failedAttempts?: number } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE}${String(seq).padStart(2, '0')}`, firstName: 'Card', lastName: `W${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
  const due = opts.due ?? new Date(Date.now() - DAY);
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: WEEKLY,
      billingMethod: 'CARD', paymentToken: opts.paymentToken === undefined ? LEGACY_SENTINEL : opts.paymentToken,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
      failedAttempts: opts.failedAttempts ?? 0,
    },
  });
  subIds.push(sub.id);
  return { userId: user.id, subId: sub.id, due, periodKey: due.toISOString().slice(0, 10) };
}

async function card(p: { userId: string; subId: string }, opts: { binding?: CardRailBinding; token?: string; expMonth?: number; expYear?: number; status?: 'REPLACED' | 'REVOKED' } = {}) {
  const b = opts.binding ?? BINDING;
  const token = opts.token ?? `fake_tok_${nanoid(12)}`;
  const row = await app.prisma.paymentInstrument.create({
    data: {
      subscriptionId: p.subId, userId: p.userId,
      provider: b.provider, environment: b.environment, providerAccount: b.account,
      ...(await sealVaultToken(token)),
      brand: 'VISA', last4: '1111', expMonth: opts.expMonth ?? 12, expYear: opts.expYear ?? new Date().getUTCFullYear() + 3,
      consentVersion: 'card-on-file-v1', consentAt: new Date(),
      ...(opts.status === 'REPLACED' ? { status: 'REPLACED', replacedAt: new Date() } : {}),
      ...(opts.status === 'REVOKED' ? { status: 'REVOKED', revokedAt: new Date(), revokedBy: p.userId } : {}),
    },
  });
  return { id: row.id, token };
}

const load = (subId: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id: subId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
const bill = async (subId: string, now?: Date) => billing.billSubscription((await load(subId)) as never, now);

async function facts(subId: string) {
  const [sub, payments, events] = await Promise.all([
    app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } }),
    app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId }, orderBy: { createdAt: 'asc' } }),
    app.prisma.billingEvent.findMany({ where: { subscriptionId: subId }, select: { type: true, note: true } }),
  ]);
  const count = (t: string) => events.filter((e) => e.type === t).length;
  return {
    sub, payments,
    successes: count('CHARGE_SUCCESS'), failures: count('CHARGE_FAILED'),
    failureNotes: events.filter((e) => e.type === 'CHARGE_FAILED').map((e) => e.note),
    ledger: await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: { startsWith: `ledger:success:${subId}:` } } }),
  };
}

const kindsFor = async (userId: string) =>
  (await app.prisma.notification.findMany({ where: { userId }, select: { data: true } }))
    .map((n) => (n.data as Record<string, unknown> | null)?.['kind']);

const pagedFor = (alert: string, key: 'instrumentId' | 'paymentId', id: string) =>
  app.prisma.notification.count({ where: { AND: [{ data: { path: ['alert'], equals: alert } }, { data: { path: [key], equals: id } }] } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382/5';
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
  fake = new FakeCardRail(BINDING);
  legacy = new LegacySpy();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), legacy, observer, () => fake);
});

afterEach(() => {
  fake.mode = 'ok'; fake.charges.length = 0; fake.retrieves.length = 0; fake.captures.clear();
  legacy.calls = [];
  armed = false;
  process.env['CARD_RAIL_V2'] = '1';
  delete process.env['CARD_RAIL_KILL'];
});

afterAll(async () => {
  await cleanupBillingClocks(app.prisma, subIds);
  delete process.env['CARD_RAIL_V2'];
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  // Purge the whole synthetic payer before its retained authority sources.
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.close();
});

describe('the weekly charge uses the ACTIVE instrument, through the provider recorded on it', () => {
  it('[paymentToken law] the card’s own sealed token is sent to its own provider setup — the legacy token is never read, and the legacy seam never runs', async () => {
    const p = await cardSub();
    const inst = await card(p);
    expect(await bill(p.subId)).toBe('succeeded');
    expect(fake.charges).toHaveLength(1);
    expect(fake.charges[0]).toEqual({ vaultToken: inst.token, binding: BINDING, idempotencyKey: `card:${p.subId}:${p.periodKey}:a0`, amountMinor: MINOR, currencyCode: 'GYD' });
    expect(fake.charges.map((c) => c.vaultToken)).not.toContain(LEGACY_SENTINEL);
    expect(legacy.calls).toEqual([]);
    const after = await facts(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'CAPTURED', instrumentId: inst.id, clientKey: `card:${p.subId}:${p.periodKey}:a0` })]);
    expect([after.successes, after.failures, after.ledger]).toEqual([1, 0, 1]);
    expect(after.sub.nextBillingDate.getTime()).toBe(p.due.getTime() + 7 * DAY);
  });

  it('no ACTIVE card: nothing is sent anywhere — not the legacy token either — and the week fails with the truth', async () => {
    const p = await cardSub();
    expect(await bill(p.subId)).toBe('failed');
    expect(fake.charges).toEqual([]);
    expect(legacy.calls).toEqual([]);
    const after = await facts(p.subId);
    expect(after.failureNotes).toEqual([expect.stringMatching(/^There is no card on file/)]);
    expect(after.sub.failedAttempts).toBe(1);
  });

  it('an EXPIRED card is retired and never sent', async () => {
    const p = await cardSub();
    const inst = await card(p, { expMonth: 1, expYear: new Date().getUTCFullYear() - 1 });
    expect(await bill(p.subId)).toBe('failed');
    expect(fake.charges).toEqual([]);
    expect(await app.prisma.paymentInstrument.findUniqueOrThrow({ where: { id: inst.id } })).toMatchObject({ status: 'EXPIRED', expiredAt: expect.any(Date) });
    expect((await facts(p.subId)).failureNotes).toEqual([expect.stringMatching(/expired/)]);
  });

  it('REPLACED and REVOKED cards never charge', async () => {
    const p = await cardSub();
    await card(p, { status: 'REPLACED' });
    await card(p, { status: 'REVOKED' });
    expect(await bill(p.subId)).toBe('failed');
    expect(fake.charges).toEqual([]);
  });

  it('prepaid money is still spent first: the card is not charged while the wallet covers the week', async () => {
    const p = await cardSub();
    await card(p);
    await app.prisma.prepaidBalance.create({ data: { subscriptionId: p.subId, balance: WEEKLY, currencyCode: 'GYD' } });
    expect(await bill(p.subId)).toBe('succeeded');
    expect(fake.charges).toEqual([]);
  });
});

describe('[C4] requires_action (off-session 3-D Secure) is not a decline', () => {
  it('no strike, no CHARGE_FAILED, no second instruction for the attempt — and ONE "confirm your card" notice', async () => {
    const p = await cardSub({ failedAttempts: 0 });
    await card(p);
    fake.mode = 'requires_action';
    const before = Date.now();
    expect(await bill(p.subId)).toBe('pending');
    let after = await facts(p.subId);
    expect(after.sub.failedAttempts).toBe(0);
    expect(after.sub.status).toBe('ACTIVE');
    expect(after.failures).toBe(0);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'FAILED', failureCode: 'REQUIRES_ACTION' })]);
    expect(after.payments[0]!.failureRaw).toMatchObject({ subscriptionOutcome: 'PRESERVED_NO_DUNNING', providerOutcome: 'REQUIRES_ACTION' });
    // [#1393 owner decision] A card waiting for its 3-D Secure step is being
    // confirmed: the instruction holds the shared clock, so no retry, reminder
    // or suspension runs until it is confirmed either way.
    expect(after.sub.billingConfirmationPausedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(after.sub.nextRetryAt).toBeNull();
    expect(await app.prisma.paymentConfirmationHold.findUniqueOrThrow({ where: { paymentId: after.payments[0]!.id } }))
      .toMatchObject({ status: 'ACTIVE' });
    expect((await kindsFor(p.userId)).filter((k) => k === 'billing_card_action_required')).toHaveLength(1);
    // The notice says only what is true (the fee-notice law): no card door the app lacks yet, no instant restore.
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: p.userId, title: 'Card payment not completed' } });
    for (const door of [/tap pay/i, /open the app to pay/i, /pay (?:your weekly fee )?in the app/i, /update your card/i, /add a (?:new )?card/i, /instantly/i]) {
      expect(notice.body).not.toMatch(door);
    }
    expect(notice.body).toMatch(/not charged/);
    // [owner rule 2026-09-29, MMG checkout 2/6] The paying sentence every fee
    // notice carries: with the MMG checkout off here, the amount due, promising
    // no way to pay; never an MMG agent, cash, a Swift Number or an account number.
    expect(notice.body).toMatch(/The weekly fee of \S+ is due now\./);
    expect(notice.body).not.toMatch(/MMG agent|any agent|Swift Number|account number|pay cash|coming soon/i);
    expect(notice.body).not.toMatch(/\bagents?\b|swift number|\bcash\b/i);

    // The cycle comes back (hours later, the attempt reclaimed): still no charge, no strike, no second notice.
    expect(await bill(p.subId, new Date(Date.now() + 2 * 60 * 60 * 1000))).toBe('pending');
    after = await facts(p.subId);
    expect(fake.charges).toHaveLength(1);
    expect(after.sub.failedAttempts).toBe(0);
    expect(after.failures).toBe(0);
    expect((await kindsFor(p.userId)).filter((k) => k === 'billing_card_action_required')).toHaveLength(1);
  });

  it('a genuine decline IS a strike (the contrast that makes the rule mean something)', async () => {
    const p = await cardSub();
    await card(p);
    fake.mode = 'decline';
    expect(await bill(p.subId)).toBe('failed');
    const after = await facts(p.subId);
    expect([after.sub.failedAttempts, after.failures]).toEqual([1, 1]);
  });
});

describe('an ambiguous answer is never a second capture', () => {
  it('[capture-then-timeout] the provider captured but the answer was lost: one intent, one capture — the reconciler retrieves it and books it once', async () => {
    const p = await cardSub();
    await card(p);
    fake.mode = 'capture-then-timeout';
    expect(await bill(p.subId)).toBe('pending');
    expect((await facts(p.subId)).payments).toEqual([expect.objectContaining({ status: 'UNKNOWN', failureCode: 'TIMEOUT_UNKNOWN' })]);
    expect(await bill(p.subId)).toBe('pending'); // a rerun owns the same intent: nothing is re-sent
    expect(fake.charges).toHaveLength(1);
    const tick = await billing.reconcileUnknownCardCharges();
    expect(tick.settled).toBeGreaterThanOrEqual(1);
    const after = await facts(p.subId);
    expect([after.successes, after.ledger, fake.captures.size, fake.charges.length]).toEqual([1, 1, 1, 1]);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'CAPTURED' })]);
    expect(fake.retrieves).toContain(`card:${p.subId}:${p.periodKey}:a0`);
  });

  it('[M-01 on v2] the process dies right after the capture: the rerun and the reconciler converge on ONE capture and one booked week', async () => {
    const p = await cardSub();
    await card(p);
    armed = true;
    await expect(bill(p.subId)).rejects.toThrow(/failpoint/);
    expect(fake.captures.size).toBe(1);
    expect((await facts(p.subId)).payments).toEqual([expect.objectContaining({ status: 'UNKNOWN' })]);
    expect(await bill(p.subId)).toBe('pending');
    await billing.reconcileUnknownCardCharges();
    const after = await facts(p.subId);
    expect([after.successes, after.ledger, fake.charges.length]).toEqual([1, 1, 1]);
  });
});

describe('[C2] a token is only ever sent to the provider setup that minted it', () => {
  it('another account or environment: nothing is sent, nobody is struck, and a person is paged', async () => {
    for (const other of [{ ...BINDING, account: `${BINDING.account}-b` }, { ...BINDING, environment: 'live' as const }]) {
      const p = await cardSub();
      const inst = await card(p, { binding: other });
      expect(await bill(p.subId)).toBe('pending');
      expect(fake.charges).toEqual([]);
      const after = await facts(p.subId);
      expect([after.sub.failedAttempts, after.failures, after.payments.length]).toEqual([0, 0, 0]);
      expect(await pagedFor('card-instrument-binding-mismatch', 'instrumentId', inst.id)).toBeGreaterThan(0);
    }
  });

  it('reconciliation never asks another provider setup about an intent either', async () => {
    const p = await cardSub();
    const inst = await card(p, { binding: { ...BINDING, account: `${BINDING.account}-c` } });
    const clientKey = `card:${p.subId}:${p.periodKey}:a0`;
    await app.prisma.subscriptionPayment.create({
      data: {
        subscriptionId: p.subId, amount: WEEKLY, status: 'UNKNOWN', paymentMethod: 'CARD', clientKey, instrumentId: inst.id,
        failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD' }, periodStart: p.due, periodEnd: new Date(p.due.getTime() + 7 * DAY),
      },
    });
    await billing.reconcileUnknownCardCharges();
    expect(fake.retrieves).not.toContain(clientKey);
    expect((await facts(p.subId)).payments).toEqual([expect.objectContaining({ status: 'UNKNOWN' })]);
  });
});

describe('a capture that reports another amount is HELD, never booked', () => {
  it('100x the fee (a minor-unit mistake): no week granted, no strike, the intent held with both figures, a person paged — and nothing re-sent', async () => {
    const p = await cardSub();
    await card(p);
    fake.mode = 'misprice';
    expect(await bill(p.subId)).toBe('pending');
    const after = await facts(p.subId);
    expect([after.successes, after.failures, after.sub.failedAttempts]).toEqual([0, 0, 0]);
    expect(after.sub.nextBillingDate.getTime()).toBe(p.due.getTime());
    const [payment] = after.payments;
    expect(payment).toMatchObject({ status: 'UNKNOWN', failureCode: 'AMOUNT_MISMATCH' });
    expect(payment!.failureRaw).toMatchObject({
      recoveryDisposition: 'MANUAL_RECONCILIATION',
      reported: { amountMinor: MINOR * 100, currencyCode: 'GYD' },
      intended: { amountMinor: MINOR, currencyCode: 'GYD' },
    });
    expect(await pagedFor('card-charge-amount-mismatch', 'paymentId', payment!.id)).toBeGreaterThan(0);
    expect(await bill(p.subId)).toBe('pending');
    await billing.reconcileUnknownCardCharges();
    expect(fake.charges).toHaveLength(1);
    expect(fake.retrieves).not.toContain(payment!.clientKey);
    expect((await facts(p.subId)).successes).toBe(0);
  });
});

describe('[C7] the kill switch stops new charges, never reconciliation', () => {
  it('killed: no charge is sent — yet an intent already out is retrieved and booked', async () => {
    const out = await cardSub();
    await card(out);
    fake.mode = 'capture-then-timeout';
    expect(await bill(out.subId)).toBe('pending');
    fake.mode = 'ok';
    process.env['CARD_RAIL_KILL'] = '1';
    const fresh = await cardSub();
    await card(fresh);
    expect(await bill(fresh.subId)).toBe('pending');
    expect(fake.charges.map((c) => c.idempotencyKey)).toEqual([`card:${out.subId}:${out.periodKey}:a0`]);
    await billing.reconcileUnknownCardCharges();
    expect((await facts(out.subId)).successes).toBe(1);
    expect((await facts(fresh.subId)).payments).toEqual([]);
  });
});

describe('CARD_RAIL_V2 defaults OFF', () => {
  it('flag off: an enrolled card is never charged by v2 — billing is exactly the legacy path', async () => {
    process.env['CARD_RAIL_V2'] = '';
    const p = await cardSub({ paymentToken: null });
    await card(p);
    expect(await bill(p.subId)).toBe('failed');
    expect(fake.charges).toEqual([]);
    expect((await facts(p.subId)).failureNotes).toEqual(['Insufficient prepaid balance']);
  });
});

describe('[AX297 F5] CARD_RAIL_V2 off: the worker billing asks no v2 provider about anything', () => {
  it('a v2 charge already out is not retrieved (it stays UNKNOWN, counted); with a provider wired, as CARD_RAIL_V2_DRAIN=1 wires one, it is retrieved and booked once', async () => {
    const p = await cardSub();
    await card(p);
    fake.mode = 'capture-then-timeout';
    expect(await bill(p.subId)).toBe('pending'); // captured at the provider; the answer was lost
    fake.retrieves.length = 0;

    // [AX318 R4] A legacy card intent in the same pass: the flag-off pass must still work it (stamp it).
    const legacyRow = await cardSub();
    await app.prisma.subscriptionPayment.create({ data: {
      subscriptionId: legacyRow.subId, amount: WEEKLY, status: 'UNKNOWN', paymentMethod: 'CARD', clientKey: `card:${legacyRow.subId}:${legacyRow.periodKey}:a0`,
      periodStart: legacyRow.due, periodEnd: new Date(legacyRow.due.getTime() + 7 * DAY), failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD' },
    } });
    expect((await facts(p.subId)).payments[0]!.lastPolledAt).toBeNull();

    const workerOff = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), legacy, {}, cardRailWorkerSource({ redis: {} as never }, { CARD_RAIL_V2: '0' }));
    await workerOff.reconcileUnknownCardCharges();
    expect(fake.retrieves).toEqual([]);
    let after = await facts(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'UNKNOWN' })]);
    expect(after.successes).toBe(0);
    expect(after.payments[0]!.lastPolledAt, 'the flag-off worker wrote to a v2 row [AX318 R4]').toBeNull();
    expect((await facts(legacyRow.subId)).payments[0]!.lastPolledAt, 'the pass did not run at all').not.toBeNull();

    const workerDraining = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), legacy, {}, () => fake);
    await workerDraining.reconcileUnknownCardCharges();
    expect(fake.retrieves).toContain(`card:${p.subId}:${p.periodKey}:a0`);
    after = await facts(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'CAPTURED' })]);
    expect([after.successes, after.ledger]).toEqual([1, 1]);
  });
});

describe('[AX318 R2] a reclaimed attempt is dispatched, checked and settled from ONE record: the one it was issued with', () => {
  it('a GYD attempt defers, the subscription becomes USD, the attempt is reclaimed: GYD is sent and GYD is booked, never a USD capture labelled GYD', async () => {
    const p = await cardSub();
    const x = await card(p);
    let replaced = false;
    const racing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), legacy, {
      // The first dispatch defers: the card is replaced after the cycle read it.
      beforeInstrumentChargeAuthorization: async () => {
        if (replaced) return;
        replaced = true;
        await app.prisma.paymentInstrument.update({ where: { id: x.id }, data: { status: 'REPLACED', replacedAt: new Date() } });
        await card(p);
      },
    }, () => fake);
    expect(await racing.billSubscription((await load(p.subId)) as never)).toBe('pending');
    expect(fake.charges).toEqual([]);
    await app.prisma.subscription.update({ where: { id: p.subId }, data: { currencyCode: 'USD' } });

    expect(await racing.billSubscription((await load(p.subId)) as never, new Date(Date.now() + 31 * 60_000))).toBe('succeeded');
    expect(fake.charges).toHaveLength(1);
    const success = await app.prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: p.subId, type: 'CHARGE_SUCCESS' } });
    expect(fake.charges[0]!.currencyCode, 'dispatched in one currency, booked in another').toBe(success.currencyCode);
    expect(fake.charges[0]).toMatchObject({ currencyCode: 'GYD', amountMinor: MINOR });
    expect([success.currencyCode, Number(success.amount)]).toEqual(['GYD', WEEKLY]);
  });
});

describe('[AX318 R3] a weekly capture that cannot be pinned is held AND put in front of the tenant admins', () => {
  it('its attempt record is gone at settlement: held CURRENCY_UNPINNED, nothing booked, the admins paged', async () => {
    const p = await cardSub();
    await card(p);
    const racing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), legacy, {
      afterProviderReturned: async () => {
        await app.prisma.billingEvent.deleteMany({ where: { idempotencyKey: `charge:${p.subId}:${p.periodKey}:a0` } });
      },
    }, () => fake);
    expect(await racing.billSubscription((await load(p.subId)) as never)).toBe('skipped');
    const after = await facts(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({ status: 'UNKNOWN', failureCode: 'CURRENCY_UNPINNED', externalRef: expect.stringMatching(/^fk_/) })]);
    expect(after.successes).toBe(0);
    expect(await pagedFor('card-capture-currency-unpinned', 'paymentId', after.payments[0]!.id), 'only an error log').toBeGreaterThan(0);
  });
});

describe('[AX318 R1] a run that dies between authorization and handoff sent nothing: nobody is asked, and past a grace the attempt is billed again, once', () => {
  it('inside the grace the AUTHORIZED intent is left alone; past it, it is closed NOT_SENT with no question to the provider and no strike, and the next cycle charges once', async () => {
    const p = await cardSub();
    const x = await card(p);
    const dying = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), legacy, {
      beforeInstrumentChargeHandoff: async () => { throw new Error('failpoint: the process died between authorization and handoff'); },
    }, () => fake);
    await expect(dying.billSubscription((await load(p.subId)) as never)).rejects.toThrow(/died between authorization and handoff/);
    expect(fake.charges).toEqual([]);
    const [intent] = (await facts(p.subId)).payments;
    expect(intent).toMatchObject({ status: 'UNKNOWN', instrumentId: x.id, failureRaw: expect.objectContaining({ providerEffect: 'AUTHORIZED' }) });
    const key = intent!.clientKey!;

    // Inside the grace a live run could still be between its two phases: left alone, and nobody is asked.
    await billing.reconcileUnknownCardCharges();
    expect((await facts(p.subId)).payments).toEqual([expect.objectContaining({ id: intent!.id, status: 'UNKNOWN', failureRaw: expect.objectContaining({ providerEffect: 'AUTHORIZED' }) })]);
    expect(fake.retrieves, 'a charge that was never sent was asked about').not.toContain(key);

    // Past the grace (only this row is aged, and it is due a poll again): closed, key released, nobody asked, nobody penalised.
    await app.prisma.subscriptionPayment.update({ where: { id: intent!.id }, data: { createdAt: new Date(intent!.createdAt.getTime() - 11 * 60_000), lastPolledAt: null } });
    await billing.reconcileUnknownCardCharges();
    let after = await facts(p.subId);
    expect(after.payments).toEqual([expect.objectContaining({
      id: intent!.id, status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', clientKey: `${key}:void:${intent!.id}`,
      failureRaw: expect.objectContaining({ providerEffect: 'NOT_SENT', cancelledBy: 'NEVER_HANDED_OFF' }),
    })]);
    expect(fake.retrieves, 'a charge that was never sent was asked about').not.toContain(key);
    expect([fake.charges.length, after.successes, after.failures, after.sub.failedAttempts]).toEqual([0, 0, 0, 0]);

    // Billed again from the top, once, under the key the provider never saw.
    expect(await bill(p.subId, new Date(Date.now() + 31 * 60_000))).toBe('succeeded');
    expect(fake.charges.map((c) => c.idempotencyKey)).toEqual([key]);
    after = await facts(p.subId);
    expect(after.payments.map((r) => r.status)).toEqual(['EXPIRED', 'CAPTURED']);
    expect([after.successes, after.ledger]).toEqual([1, 1]);
  });
});
