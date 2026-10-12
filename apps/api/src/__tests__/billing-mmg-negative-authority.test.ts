import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { MmgTxStatus } from '../providers/mmg/mmg-provider';

// These tests isolate provider-result authority. The real payer-lock/clock
// implementations have PostgreSQL coverage in billing-confirmation-clock;
// here their explicit seams cannot turn a wrong provider answer into proof.
const seams = vi.hoisted(() => ({
  lookup: vi.fn(), initiate: vi.fn(), begin: vi.fn(), resolve: vi.fn(),
}));
vi.mock('../providers/mmg/mmg-provider', async (original) => ({
  ...await original<typeof import('../providers/mmg/mmg-provider')>(),
  getMmgProvider: () => ({ transactionLookup: seams.lookup, initiatePayment: seams.initiate,
    transactionHistory: vi.fn(async () => []) }),
}));
vi.mock('../modules/billing/dunning-clock', async (original) => ({
  ...await original<typeof import('../modules/billing/dunning-clock')>(),
  currentDunningClock: vi.fn(async () => ({ id: 'clock-1', epoch: 1 })),
  beginConfirmationInTx: seams.begin,
  resolvePaymentConfirmationInTx: seams.resolve,
}));
import { mmgTerminalProof } from '../modules/billing/mmg-terminal-evidence';
import { BillingService } from '../modules/billing/billing.service';

const now = new Date('2026-09-30T12:00:00Z');
const due = new Date('2026-09-28T12:00:00Z');
function harness() {
  const payment: any = { id: 'payment-1', subscriptionId: 'sub-1', amount: 2100,
    status: 'PENDING', paymentMethod: 'MOBILE_MONEY', externalRef: 'mmg-real',
    clientKey: 'sub:sub-1:2026-09-28:a0', periodStart: due, periodEnd: now,
    createdAt: due, expiresAt: new Date('2026-10-01T12:00:00Z'),
    lastPolledAt: null, pollBackoffSec: 30, failureCode: null,
    failureRaw: { providerEffect: 'AUTHORIZED' } };
  const sub: any = { id: 'sub-1', type: 'DELIVERY_RIDER', status: 'ACTIVE', autoRenew: true,
    billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: 'synthetic-payer', currencyCode: 'GYD',
    nextBillingDate: due, failedAttempts: 0, nextRetryAt: null, rider: { userId: 'user-1' } };
  const db: any = {
    subscriptionPayment: {
      findMany: vi.fn(async ({ where }) => !where.status || where.status.in.includes(payment.status) ? [structuredClone(payment)] : []),
      findUnique: vi.fn(async () => structuredClone(payment)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status?.in && !where.status.in.includes(payment.status)) return { count: 0 };
        Object.assign(payment, data); return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => { Object.assign(payment, data); return structuredClone(payment); }),
    },
    subscription: { findUnique: vi.fn(async () => ({ ...sub })),
      update: vi.fn(async ({ data }) => { Object.assign(sub, data); return { ...sub }; }) },
    billingEvent: { findUnique: vi.fn(async ({ where }) => where.idempotencyKey?.startsWith('charge:') ? { currencyCode: 'GYD' } : null),
      findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }) => data) },
    prepaidBalance: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async (sql) => String(sql).includes('COUNT(*) OVER()') && ['FAILED', 'EXPIRED'].includes(payment.status)
      ? [{ ...payment, openCount: 1 }] : []),
  };
  db.$transaction = async (fn: any) => fn(db);
  const service: any = new BillingService(db as PrismaClient, {} as any, {} as any);
  vi.spyOn(service, 'lockPaymentOutcomeAuthority').mockResolvedValue({ bankInsteadOfAdvance: false, status: 'ACTIVE' });
  vi.spyOn(service, 'subscriptionHasConfirmationHold').mockResolvedValue(false);
  const reserve = vi.spyOn(service, 'reserveMmgIntent').mockResolvedValue(null);
  const failure = vi.spyOn(service, 'recordFailureInTx').mockImplementation(async () => {
    sub.failedAttempts += 1; sub.status = 'PAST_DUE';
    return { willSuspend: false, attempts: sub.failedAttempts };
  });
  vi.spyOn(service, 'afterFailureNotices').mockResolvedValue(undefined);
  const answer = (status: MmgTxStatus = 'declined') => ({ status, transactionId: payment.externalRef,
    reference: payment.clientKey, amountMinor: 210000, currencyCode: 'GYD' });
  return { service, payment, sub, db, reserve, failure, answer };
}
beforeEach(() => { vi.clearAllMocks(); seams.begin.mockResolvedValue({ id: 'hold-1' }); seams.resolve.mockResolvedValue(undefined); });

describe('MMG negative results need exact durable intent authority', () => {
  for (const status of ['declined', 'expired', 'reversed'] as const) {
    for (const mismatch of ['transactionId', 'reference', 'missingReference', 'amount', 'currency']) {
      it(`${status} ${mismatch} cannot authorize a second provider instruction`, async () => {
        const h = harness(); h.payment.status = 'FAILED'; const answer: any = h.answer(status);
        if (mismatch === 'transactionId') answer.transactionId = 'mmg-other';
        if (mismatch === 'reference') answer.reference = 'another-request';
        if (mismatch === 'missingReference') delete answer.reference;
        if (mismatch === 'amount') answer.amountMinor = 1;
        if (mismatch === 'currency') answer.currencyCode = 'USD';
        seams.lookup.mockResolvedValue(answer);
        expect(await h.service.attemptCharge(h.sub, 2100, now)).toMatchObject({ deferred: true });
        expect(h.reserve).not.toHaveBeenCalled();
        expect(seams.initiate).not.toHaveBeenCalled();
      });
      it(`${status} ${mismatch} cannot terminalize or dun the polled intent`, async () => {
        const h = harness(); const answer: any = h.answer(status);
        if (mismatch === 'transactionId') answer.transactionId = 'mmg-other';
        if (mismatch === 'reference') answer.reference = 'another-request';
        if (mismatch === 'missingReference') delete answer.reference;
        if (mismatch === 'amount') answer.amountMinor = 1;
        if (mismatch === 'currency') answer.currencyCode = 'USD';
        seams.lookup.mockResolvedValue(answer);
        expect(await h.service.pollPendingMmgCharges(now)).toMatchObject({ failed: 0, stillPending: 1 });
        expect(['UNKNOWN', 'PENDING']).toContain(h.payment.status);
        expect(h.failure).not.toHaveBeenCalled();
        expect(seams.resolve).not.toHaveBeenCalled();
      });
    }
    it(`bound ${status} is recorded before its one dunning outcome`, async () => {
      const h = harness(); seams.lookup.mockResolvedValue(h.answer(status));
      expect(await h.service.pollPendingMmgCharges(now)).toMatchObject({ failed: 1 });
      expect(h.payment.failureRaw.mmgTerminalEvidence).toMatchObject({ version: 1, source: 'LOOKUP',
        paymentId: h.payment.id, transactionId: 'mmg-real', reference: h.payment.clientKey, status });
      expect(h.failure).toHaveBeenCalledTimes(1);
    });
  }
  for (const status of ['FAILED', 'EXPIRED']) {
    it(`legacy ${status} without provider proof returns to confirmation without dunning`, async () => {
      const h = harness(); h.payment.status = status;
      expect(await h.service.reconcileTerminalWithoutOutcome(now)).toMatchObject({ repaired: 0 });
      expect(h.payment.status).toBe('PENDING');
      expect(seams.begin).toHaveBeenCalled();
      expect(h.failure).not.toHaveBeenCalled();
      expect(h.sub.failedAttempts).toBe(0);
    });
  }
  it('an exactly bound terminal prior permits the reserve path and retains proof', async () => {
    const h = harness(); h.payment.status = 'FAILED'; seams.lookup.mockResolvedValue(h.answer());
    await h.service.attemptCharge(h.sub, 2100, now);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.payment.failureRaw.mmgTerminalEvidence).toMatchObject({ source: 'LOOKUP', transactionId: 'mmg-real' });
  });
  it('a proved old terminal cannot dun a newer obligation', async () => {
    const h = harness(); h.payment.status = 'EXPIRED';
    h.payment.failureRaw.mmgTerminalEvidence = mmgTerminalProof(h.payment, 'GYD', h.answer('expired'), 'LOOKUP', 'old-proof', due);
    h.sub.nextBillingDate = new Date(due.getTime() + 7 * 86_400_000);
    await h.service.reconcileTerminalWithoutOutcome(now);
    expect(h.failure).not.toHaveBeenCalled(); expect(h.sub.failedAttempts).toBe(0);
  });
  it('legacy terminal repair accepts complete matching durable proof once', async () => {
    const h = harness(); h.payment.status = 'EXPIRED';
    h.payment.failureRaw.mmgTerminalEvidence = mmgTerminalProof(h.payment, 'GYD', h.answer('expired'), 'LOOKUP', 'prior-observation', due);
    expect(await h.service.reconcileTerminalWithoutOutcome(now)).toMatchObject({ repaired: 1 });
    expect(h.failure).toHaveBeenCalledTimes(1);
  });
  for (const fact of ['paymentId', 'subscriptionId', 'periodStart', 'periodEnd', 'transactionId', 'reference', 'amountMinor', 'currencyCode']) {
    it(`legacy repair rejects durable proof for a different ${fact}`, async () => {
      const h = harness(); h.payment.status = 'FAILED';
      const proof = mmgTerminalProof(h.payment, 'GYD', h.answer(), 'LOOKUP', 'old-observation', due);
      h.payment.failureRaw.mmgTerminalEvidence = { ...proof, [fact]: fact === 'amountMinor' ? 1 : 'different' };
      expect(await h.service.reconcileTerminalWithoutOutcome(now)).toMatchObject({ repaired: 0 });
      expect(h.failure).not.toHaveBeenCalled(); expect(h.payment.status).toBe('PENDING');
    });
  }
  for (const fact of ['CAPTURED', 'HISTORY_APPROVAL_UNVERIFIED', 'SETTLEMENT_MISMATCH']) {
    it(`a reordered negative cannot overwrite ${fact}`, async () => {
      const h = harness(); const answer = h.answer();
      seams.lookup.mockImplementation(async () => {
        if (fact === 'CAPTURED') h.payment.status = 'CAPTURED';
        else h.payment.failureCode = fact;
        h.payment.failureRaw.providerOutcome = 'CAPTURED'; return answer;
      });
      expect(await h.service.pollPendingMmgCharges(now)).toMatchObject({ failed: 0, stillPending: 1 });
      expect(h.failure).not.toHaveBeenCalled(); expect(seams.resolve).not.toHaveBeenCalled();
      expect(h.payment.failureRaw.providerOutcome).toBe('CAPTURED');
    });
  }
  it('an older lookup cannot replace a newer observation generation', async () => {
    const h = harness(); const answer = h.answer();
    seams.lookup.mockImplementation(async () => { h.payment.failureRaw.mmgLookupGeneration = 'newer-generation'; return answer; });
    expect(await h.service.pollPendingMmgCharges(now)).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.payment.failureRaw.mmgLookupGeneration).toBe('newer-generation');
    expect(seams.begin).not.toHaveBeenCalled(); expect(h.failure).not.toHaveBeenCalled();
  });
  it('a prior negative cannot authorize dispatch after a newer paid obligation won', async () => {
    const h = harness(); const snapshot = { ...h.sub };
    h.payment.status = 'UNKNOWN'; h.payment.externalRef = null;
    h.sub.nextBillingDate = new Date(due.getTime() + 7 * 86_400_000);
    expect(await h.service.authorizeProviderEffect(snapshot, h.payment.id, 'MOBILE_MONEY', now)).toBe(false);
    expect(h.payment.failureRaw.providerEffect).toBe('NOT_SENT');
    expect(seams.initiate).not.toHaveBeenCalled(); expect(seams.begin).not.toHaveBeenCalled();
  });
  it('local TTL cannot close a dispatched pending request', async () => {
    const h = harness(); h.payment.expiresAt = due; seams.lookup.mockResolvedValue(h.answer('pending'));
    expect(await h.service.pollPendingMmgCharges(now)).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.payment.status).toBe('PENDING'); expect(h.failure).not.toHaveBeenCalled();
  });
  it('a changed payment binding after lookup is checked again under the authority lock', async () => {
    const h = harness(); const answer = h.answer();
    seams.lookup.mockImplementation(async () => { h.payment.externalRef = 'replacement-id'; return answer; });
    expect(await h.service.pollPendingMmgCharges(now)).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.failure).not.toHaveBeenCalled(); expect(seams.resolve).not.toHaveBeenCalled();
  });
});
