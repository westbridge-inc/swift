import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService, type BillingObserver } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import type { ChargeLookup, ChargeResult, PaymentProvider } from '../providers/payment/payment-provider';
import { cardIntentsUnknownGauge } from '../plugins/observability';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [M-01 / M-02 · S0] The card rail: the intent before the effect, an honest
// UNKNOWN, one key per attempt, retrieve before retry.
//
// Before: the processor was asked with nothing durable on our side, so a
// process that died after the capture and before applySuccessfulCharge left
// a charged payer with no paid week, no payment row and no ledger line, and
// every rerun collided on the attempt key and skipped forever (M-01). And a
// transport timeout became a decline: dunning started, and the next retry
// carried a NEW key — a second capture and a wrongful suspension (M-02).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200681';
let app: FastifyInstance;
let billing: BillingService;
let fake: FakeCardProcessor;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

/** A processor double with the two properties the register needs: it records
 *  a capture the instant it happens (whatever it then answers), and the same
 *  idempotency key answers the same result — one capture per key, ever. */
class FakeCardProcessor implements PaymentProvider {
  readonly captures = new Map<string, ChargeResult>();
  readonly keysSeen: string[] = [];
  lookups = 0;
  mode: 'ok' | 'decline' | 'capture-then-timeout' | 'timeout-no-capture' = 'ok';
  lookupMode: 'normal' | 'unreachable' = 'normal';
  async tokenizeCard(): Promise<{ token: string }> { return { token: 'tok_fake' }; }
  async chargeToken(input: { token: string; amount: number; currencyCode: string; idempotencyKey: string }): Promise<ChargeResult> {
    this.keysSeen.push(input.idempotencyKey);
    const seen = this.captures.get(input.idempotencyKey);
    if (seen) return seen;
    if (this.mode === 'decline') {
      const declined: ChargeResult = { status: 'failed', providerRef: `ch_${nanoid(6)}`, reason: 'Card declined' };
      this.captures.set(input.idempotencyKey, declined);
      return declined;
    }
    if (this.mode === 'timeout-no-capture') return { status: 'unknown', providerRef: '', reason: 'Gateway unreachable' };
    const captured: ChargeResult = { status: 'succeeded', providerRef: `ch_${nanoid(6)}` };
    this.captures.set(input.idempotencyKey, captured);
    if (this.mode === 'capture-then-timeout') return { status: 'unknown', providerRef: '', reason: 'Gateway unreachable' };
    return captured;
  }
  async refund(): Promise<ChargeResult> { return { status: 'succeeded', providerRef: `re_${nanoid(6)}` }; }
  async lookupCharge(input: { idempotencyKey: string; providerRef?: string }): Promise<ChargeLookup> {
    this.lookups += 1;
    if (this.lookupMode === 'unreachable') return { status: 'unknown', reason: 'Gateway unreachable' };
    const seen = this.captures.get(input.idempotencyKey);
    if (!seen) return { status: 'not_found' };
    return { status: seen.status === 'succeeded' ? 'succeeded' : 'failed', providerRef: seen.providerRef, reason: seen.reason };
  }
}

/** The failpoint: armed once, it throws the instant the processor has answered. */
let armed = false;
const observer: BillingObserver = {
  afterProviderReturned: async () => {
    if (!armed) return;
    armed = false;
    throw new Error('failpoint: the process died after the processor answered, before any local write');
  },
};

async function makeCardSub(due: Date) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Card', lastName: `U${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('billing-card') },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 12000,
      billingMethod: 'CARD', paymentToken: 'tok_fake',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    },
  });
  subIds.push(sub.id);
  return sub.id;
}
const load = (subId: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id: subId },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
const bill = async (subId: string) => billing.billSubscription((await load(subId)) as never);

async function facts(subId: string, periodKey: string) {
  const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
  const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId }, orderBy: { createdAt: 'asc' } });
  const events = await app.prisma.billingEvent.groupBy({ by: ['type'], where: { subscriptionId: subId }, _count: true });
  const count = (t: string) => events.find((e) => e.type === t)?._count ?? 0;
  return {
    status: sub.status,
    failedAttempts: sub.failedAttempts,
    nextBillingDate: sub.nextBillingDate.getTime(),
    payments: payments.map((p) => ({ status: p.status, code: p.failureCode, key: p.clientKey })),
    attempts: count('CHARGE_ATTEMPT'),
    successes: count('CHARGE_SUCCESS'),
    failures: count('CHARGE_FAILED'),
    ledger: await app.prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:success:${subId}:${periodKey}` } }),
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  fake = new FakeCardProcessor();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), fake, observer);
});

afterEach(() => {
  // Each case gets a processor with an empty memory: keys and captures are
  // per-subscription facts, and a case asserts exactly what IT caused.
  fake.mode = 'ok'; fake.lookupMode = 'normal'; fake.keysSeen.length = 0; fake.captures.clear(); fake.lookups = 0;
  armed = false; delete process.env['CARD_RAIL_KILL'];
});

afterAll(async () => {
  delete process.env['CARD_RAIL_KILL'];
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[M-01] a capture the process never recorded', () => {
  it('the register’s red test: the processor captures, the process dies before any local write; the rerun and the reconciler converge to ONE capture, one payment, one period advance, one success event, one ledger posting', async () => {
    const due = new Date(Date.now() - DAY); const periodKey = due.toISOString().slice(0, 10);
    const subId = await makeCardSub(due);
    armed = true;
    await expect(bill(subId)).rejects.toThrow(/failpoint/);
    // Money moved at the processor; locally only the intent stands.
    expect(fake.captures.size).toBe(1);
    expect(await facts(subId, periodKey)).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due.getTime(), attempts: 1, successes: 0, failures: 0, ledger: 0 });
    expect((await facts(subId, periodKey)).payments).toEqual([{ status: 'UNKNOWN', code: null, key: expect.stringMatching(/^card:/) }]);
    // The rerun does not skip forever and does not charge again: the live intent is the poller's.
    expect(await bill(subId)).toBe('pending');
    expect(fake.keysSeen).toHaveLength(1);
    // The reconciler retrieves the truth by the same key and repairs the record.
    const result = await billing.reconcileUnknownCardCharges();
    expect(result.settled).toBeGreaterThanOrEqual(1);
    const after = await facts(subId, periodKey);
    expect(after).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due.getTime() + 7 * DAY, attempts: 1, successes: 1, failures: 0, ledger: 1 });
    expect(after.payments).toEqual([{ status: 'CAPTURED', code: null, key: expect.stringMatching(/^card:/) }]);
    expect(fake.captures.size).toBe(1);
    expect(fake.keysSeen).toHaveLength(1); // retrieved, never re-sent
    // Again: nothing left to reconcile.
    expect((await billing.reconcileUnknownCardCharges()).settled).toBe(0);
  });
});

describe('[M-02] an ambiguous result is not a decline', () => {
  it('the register’s red test: the processor captures but the response times out — no dunning, the same key, one capture settled by the next tick', async () => {
    const due = new Date(Date.now() - DAY); const periodKey = due.toISOString().slice(0, 10);
    const subId = await makeCardSub(due);
    fake.mode = 'capture-then-timeout';
    expect(await bill(subId)).toBe('pending');
    const mid = await facts(subId, periodKey);
    expect(mid).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, attempts: 1, successes: 0, failures: 0, ledger: 0 });
    expect(mid.payments).toEqual([{ status: 'UNKNOWN', code: 'TIMEOUT_UNKNOWN', key: expect.stringMatching(/:a0$/) }]);
    // A rerun before the tick: still the same intent, still no second instruction.
    expect(await bill(subId)).toBe('pending');
    expect(fake.keysSeen).toHaveLength(1);
    // The next tick retrieves and settles — once.
    const tick = await billing.reconcileUnknownCardCharges();
    expect(tick.settled).toBeGreaterThanOrEqual(1);
    const after = await facts(subId, periodKey);
    expect(after).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due.getTime() + 7 * DAY, successes: 1, failures: 0, ledger: 1 });
    expect(after.payments.map((p) => p.status)).toEqual(['CAPTURED']);
    expect(fake.captures.size).toBe(1);
    expect(fake.keysSeen).toHaveLength(1);
  });

  it('a proven decline still enters dunning — and the next attempt is a new instruction with the next key', async () => {
    const due = new Date(Date.now() - DAY); const periodKey = due.toISOString().slice(0, 10);
    const subId = await makeCardSub(due);
    fake.mode = 'decline';
    expect(await bill(subId)).toBe('failed');
    const declined = await facts(subId, periodKey);
    expect(declined).toMatchObject({ failedAttempts: 1, attempts: 1, successes: 0, failures: 1, ledger: 0 });
    expect(declined.payments).toEqual([{ status: 'FAILED', code: 'PAYER_REJECTED', key: expect.stringMatching(/:a0$/) }]);
    fake.mode = 'ok';
    expect(await bill(subId)).toBe('succeeded');
    expect(fake.keysSeen).toEqual([expect.stringMatching(/:a0$/), expect.stringMatching(/:a1$/)]);
    expect((await facts(subId, periodKey)).successes).toBe(1);
  });

  it('an instruction the processor never received is re-sent under the SAME key by the reconciler, and captured once', async () => {
    const due = new Date(Date.now() - DAY); const periodKey = due.toISOString().slice(0, 10);
    const subId = await makeCardSub(due);
    fake.mode = 'timeout-no-capture';
    expect(await bill(subId)).toBe('pending');
    expect(fake.captures.size).toBe(0);
    fake.mode = 'ok';
    const tick = await billing.reconcileUnknownCardCharges();
    expect(tick.settled).toBeGreaterThanOrEqual(1);
    expect(fake.keysSeen).toHaveLength(2);
    expect(fake.keysSeen[0]).toBe(fake.keysSeen[1]); // the same key: the processor's idempotency makes it one capture
    expect(fake.captures.size).toBe(1);
    expect(await facts(subId, periodKey)).toMatchObject({ successes: 1, failures: 0, ledger: 1, failedAttempts: 0, nextBillingDate: due.getTime() + 7 * DAY });
  });
});

describe('[M-01 · operations] the kill switch and the unreachable processor', () => {
  it('the processor cannot say: the intent waits, its age is published, no instruction is sent; when it can, it settles', async () => {
    const due = new Date(Date.now() - DAY); const periodKey = due.toISOString().slice(0, 10);
    const subId = await makeCardSub(due);
    fake.mode = 'capture-then-timeout';
    expect(await bill(subId)).toBe('pending');
    fake.lookupMode = 'unreachable';
    const waiting = await billing.reconcileUnknownCardCharges();
    expect(waiting.stillUnknown).toBeGreaterThanOrEqual(1);
    const gauge = await cardIntentsUnknownGauge.get();
    expect(gauge.values.find((v) => v.labels['measure'] === 'count')?.value).toBeGreaterThanOrEqual(1);
    expect(await bill(subId)).toBe('pending'); // retrieve-before-retry: unreachable means no new instruction
    expect(fake.keysSeen).toHaveLength(1);
    fake.lookupMode = 'normal';
    expect((await billing.reconcileUnknownCardCharges()).settled).toBeGreaterThanOrEqual(1);
    expect((await facts(subId, periodKey)).successes).toBe(1);
  });

  it('the belt inside the charge path: a live intent with no attempt record is retrieved by its key, never re-sent blind', async () => {
    // The reversed crash order (or a repaired attempt record): the intent
    // exists, the attempt event does not, so billing reaches the charge path
    // itself. It must ask the processor what it already did before sending.
    const due = new Date(Date.now() - DAY); const periodKey = due.toISOString().slice(0, 10);
    const plant = async (subId: string) => {
      const key = `card:${subId}:${periodKey}:a0`;
      await app.prisma.subscriptionPayment.create({
        data: { subscriptionId: subId, amount: 12000, status: 'UNKNOWN', paymentMethod: 'CARD', clientKey: key, periodStart: due, periodEnd: new Date(due.getTime() + 7 * DAY), failureCode: 'TIMEOUT_UNKNOWN' },
      });
      fake.captures.set(key, { status: 'succeeded', providerRef: 'ch_captured_earlier' }); // the processor did capture it
    };
    // Unreachable: no instruction, the reconciler owns it from here (the
    // attempt record now exists, so later reruns defer to the reconciler).
    const first = await makeCardSub(due); await plant(first);
    fake.lookupMode = 'unreachable';
    expect(await bill(first)).toBe('pending');
    expect(fake.keysSeen).toHaveLength(0);
    fake.lookupMode = 'normal';
    expect((await billing.reconcileUnknownCardCharges()).settled).toBeGreaterThanOrEqual(1);
    expect(await facts(first, periodKey)).toMatchObject({ successes: 1, failures: 0, ledger: 1, nextBillingDate: due.getTime() + 7 * DAY });
    // Reachable: retrieved and settled inside the charge path — nothing sent.
    const second = await makeCardSub(due); await plant(second);
    expect(await bill(second)).toBe('succeeded');
    expect(fake.keysSeen).toHaveLength(0);
    expect(fake.lookups).toBeGreaterThanOrEqual(2);
    expect(await facts(second, periodKey)).toMatchObject({ successes: 1, failures: 0, ledger: 1, nextBillingDate: due.getTime() + 7 * DAY });
  });

  it('CARD_RAIL_KILL=1 stops new instructions — and never the reconciler', async () => {
    const due = new Date(Date.now() - DAY); const periodKey = due.toISOString().slice(0, 10);
    const captured = await makeCardSub(due);
    fake.mode = 'capture-then-timeout';
    expect(await bill(captured)).toBe('pending'); // an UNKNOWN intent with a real capture behind it
    process.env['CARD_RAIL_KILL'] = '1';
    const fresh = await makeCardSub(due);
    const sent = fake.keysSeen.length;
    expect(await bill(fresh)).toBe('pending'); // deferred: nothing sent, no intent minted
    expect(fake.keysSeen).toHaveLength(sent);
    expect((await facts(fresh, periodKey)).payments).toEqual([]);
    // The reconciler still settles what the processor already did.
    expect((await billing.reconcileUnknownCardCharges()).settled).toBeGreaterThanOrEqual(1);
    expect((await facts(captured, periodKey)).successes).toBe(1);
  });
});
