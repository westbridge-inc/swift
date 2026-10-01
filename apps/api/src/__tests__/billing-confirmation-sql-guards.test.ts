import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { beginConfirmationInTx, currentDunningClock, resolveConfirmationInTx } from '../modules/billing/dunning-clock';

// ---------------------------------------------------------------------------
// Three database guards of the shared confirmation migration (20260930180000),
// exercised directly against PostgreSQL. Every fixture lives inside ONE
// transaction that is rolled back, and every refused write runs inside its own
// savepoint, so nothing is left behind.
//   1. An obligation transition books settled money in the currency of its
//      success record, which must be the subscription's currency or the exact
//      issue pin of that payment (its hosted card session or charge attempt).
//   2. A payment under a confirmation hold keeps its attempt key, except the
//      one release a card charge proven never sent is allowed.
//   3. A resolved PROVEN_UNPAID checkout pause reopens only for a person
//      (LATE_POSITIVE_REVIEW), only while its checkout is HELD, and only for
//      the obligation (epoch) it was issued for.
// ---------------------------------------------------------------------------

const db = new PrismaClient();
const DAY = 86_400_000;
class Rollback extends Error {}

afterAll(async () => { await db.$disconnect(); });

/** Run a fixture and its checks, then undo everything. */
async function rolledBack(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  await expect(db.$transaction(async (tx) => {
    await fn(tx);
    throw new Rollback('fixture rolled back');
  }, { timeout: 60_000 })).rejects.toBeInstanceOf(Rollback);
}

/** The database's answer to one write: null when accepted, else its refusal. */
async function answer(tx: Prisma.TransactionClient, write: () => Promise<unknown>): Promise<string | null> {
  const savepoint = `guard_${randomUUID().replace(/-/g, '')}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  try {
    await write();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return null;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    return error instanceof Error ? error.message : String(error);
  }
}

async function vendorFee(tx: Prisma.TransactionClient) {
  const user = await tx.user.create({ data: { phone: `+592${Math.floor(1e10 + Math.random() * 9e10)}`, firstName: 'Guard', lastName: 'Fixture',
    roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER' } });
  const owner = await tx.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await tx.vendor.create({ data: { ownerId: owner.id, name: 'SQL guard fixture', slug: `sql-guard-${randomUUID()}`,
    vendorType: 'RESTAURANT', phone: user.phone, addressLine1: 'Test street', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, acceptingOrders: true } });
  const due = new Date(Date.now() - 2 * DAY);
  const sub = await tx.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', weeklyRate: 20000, status: 'ACTIVE',
    billingMethod: 'CASH', currencyCode: 'GYD', currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due } });
  const clock = await currentDunningClock(tx, sub.id, new Date());
  return { user, sub, clock, due, periodKey: due.toISOString().slice(0, 10), end: new Date(due.getTime() + 7 * DAY) };
}
type Fee = Awaited<ReturnType<typeof vendorFee>>;

/** A captured payment for the owed week, its success record and audit, then the
 *  PAID transition that would advance the clock. Returns the database's answer. */
async function paidTransition(tx: Prisma.TransactionClient, f: Fee, opts: {
  currency: string; eventCurrency?: string; pin?: { kind: 'attempt' | 'session'; currency: string };
}): Promise<string | null> {
  const ref = `sql-guard:${randomUUID()}`;
  const sessionId = `cs${randomUUID().replace(/-/g, '')}`;
  let clientKey: string | null = null;
  if (opts.pin?.kind === 'attempt') {
    clientKey = `sub:${f.sub.id}:${f.periodKey}:a0`;
    await tx.billingEvent.create({ data: { subscriptionId: f.sub.id, type: 'CHARGE_ATTEMPT', amount: 20000, currencyCode: opts.pin.currency,
      idempotencyKey: `charge:${f.sub.id}:${f.periodKey}:a0` } });
  } else if (opts.pin?.kind === 'session') clientKey = `cardpay:${sessionId}`;
  const payment = await tx.subscriptionPayment.create({ data: { subscriptionId: f.sub.id, amount: 20000,
    paymentMethod: opts.pin?.kind === 'session' ? 'CARD' : 'MOBILE_MONEY', status: 'CAPTURED',
    periodStart: f.due, periodEnd: f.end, paidAt: new Date(), externalRef: ref, clientKey } });
  if (opts.pin?.kind === 'session') {
    await tx.cardSession.create({ data: { id: sessionId, tenantId: f.clock.tenantId, subscriptionId: f.sub.id, userId: f.user.id,
      purpose: 'PAY_NOW', status: 'SUCCEEDED', provider: 'sandbox', environment: 'sandbox', providerAccount: 'sql-guard',
      amount: 20000, currencyCode: opts.pin.currency, periodStart: f.due, stateHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + DAY), paymentId: payment.id } });
  }
  await tx.subscription.update({ where: { id: f.sub.id }, data: { currentPeriodStart: f.due, currentPeriodEnd: f.end, nextBillingDate: f.end } });
  const event = await tx.billingEvent.create({ data: { subscriptionId: f.sub.id, type: 'CHARGE_SUCCESS', amount: 20000,
    currencyCode: opts.eventCurrency ?? opts.currency, paymentRef: ref, idempotencyKey: `success:${f.sub.id}:${f.periodKey}` } });
  const audit = await tx.auditLog.create({ data: { action: 'BILLING_CLOCK_PAID_ADVANCE', entity: 'BillingDunningClock', entityId: f.clock.id,
    changes: { clockId: f.clock.id, tenantId: f.clock.tenantId, fromSubscriptionId: f.sub.id, subscriptionId: f.sub.id,
      previousEpoch: f.clock.epoch, nextEpoch: f.clock.epoch + 1, previousDue: f.due.toISOString(), nextDue: f.end.toISOString(),
      paymentId: payment.id, successEventId: event.id, lapseEventId: null, currencyCode: opts.currency, amount: '20000' } } });
  return answer(tx, () => tx.billingObligationTransition.create({ data: { tenantId: f.clock.tenantId, clockId: f.clock.id,
    fromSubscriptionId: f.sub.id, subscriptionId: f.sub.id, kind: 'PAID', fromEpoch: f.clock.epoch, toEpoch: f.clock.epoch + 1,
    fromDue: f.due, toDue: f.end, effectiveAt: new Date(), paymentId: payment.id, successEventId: event.id, auditId: audit.id,
    amount: 20000, currencyCode: opts.currency, periodStart: f.due, periodEnd: f.end } }));
}

describe('an obligation transition books settled money only in the subscription currency or its exact issue pin', () => {
  it('the subscription currency is accepted', async () => {
    await rolledBack(async (tx) => { expect(await paidTransition(tx, await vendorFee(tx), { currency: 'GYD' })).toBeNull(); });
  });
  it('another currency with no issue pin is refused', async () => {
    await rolledBack(async (tx) => {
      expect(await paidTransition(tx, await vendorFee(tx), { currency: 'USD' })).toMatch(/exact retained settlement proof/);
    });
  });
  it('another currency pinned by this payment’s charge attempt is accepted', async () => {
    await rolledBack(async (tx) => {
      expect(await paidTransition(tx, await vendorFee(tx), { currency: 'USD', pin: { kind: 'attempt', currency: 'USD' } })).toBeNull();
    });
  });
  it('a charge attempt pinned to yet another currency does not vouch for it', async () => {
    await rolledBack(async (tx) => {
      expect(await paidTransition(tx, await vendorFee(tx), { currency: 'USD', pin: { kind: 'attempt', currency: 'EUR' } }))
        .toMatch(/exact retained settlement proof/);
    });
  });
  it('another currency pinned by this payment’s hosted card session is accepted', async () => {
    await rolledBack(async (tx) => {
      expect(await paidTransition(tx, await vendorFee(tx), { currency: 'USD', pin: { kind: 'session', currency: 'USD' } })).toBeNull();
    });
  });
  it('the success record must be booked in the transition currency', async () => {
    await rolledBack(async (tx) => {
      expect(await paidTransition(tx, await vendorFee(tx), { currency: 'USD', eventCurrency: 'GYD', pin: { kind: 'attempt', currency: 'USD' } }))
        .toMatch(/exact retained settlement proof/);
    });
  });
});

describe('a held payment keeps its attempt key, except the release of a card charge proven never sent', () => {
  async function heldPayment(tx: Prisma.TransactionClient, method: 'CARD' | 'MOBILE_MONEY', externalRef: string | null = null) {
    const f = await vendorFee(tx);
    const payment = await tx.subscriptionPayment.create({ data: { subscriptionId: f.sub.id, amount: 20000, paymentMethod: method,
      status: 'UNKNOWN', periodStart: f.due, periodEnd: f.end, externalRef, clientKey: `card:${f.sub.id}:${f.periodKey}:a0` } });
    await beginConfirmationInTx(tx, f.sub.id, { paymentId: payment.id }, 'CARD_AUTHORIZATION_PENDING', new Date());
    return payment;
  }
  const voided = (p: { id: string; clientKey: string | null }) => `${p.clientKey}:void:${p.id}`;

  it('the exact never-sent card release is accepted', async () => {
    await rolledBack(async (tx) => {
      const p = await heldPayment(tx, 'CARD');
      expect(await answer(tx, () => tx.subscriptionPayment.update({ where: { id: p.id },
        data: { status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', clientKey: voided(p) } }))).toBeNull();
    });
  });
  it.each([
    ['any other key', { status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', key: 'card:rewritten' }],
    ['the release key without closing the charge', { status: 'UNKNOWN', failureCode: null, key: 'void' }],
    ['the release key with the revocation recorded but the charge left open', { status: 'UNKNOWN', failureCode: 'DISPATCH_REVOKED', key: 'void' }],
    ['the release key under another failure', { status: 'EXPIRED', failureCode: 'PROVIDER_ERROR', key: 'void' }],
    ['the release key with no failure recorded', { status: 'EXPIRED', failureCode: null, key: 'void' }],
  ] as const)('%s is refused', async (_name, change) => {
    await rolledBack(async (tx) => {
      const p = await heldPayment(tx, 'CARD');
      expect(await answer(tx, () => tx.subscriptionPayment.update({ where: { id: p.id }, data: {
        status: change.status, failureCode: change.failureCode, clientKey: change.key === 'void' ? voided(p) : change.key,
      } }))).toMatch(/Confirmation source ownership is immutable/);
    });
  });
  it.each([['an MMG request', 'MOBILE_MONEY', null], ['a card charge that reached the provider', 'CARD', 'ch_sent']] as const)(
    'the release is refused for %s', async (_name, method, externalRef) => {
      await rolledBack(async (tx) => {
        const p = await heldPayment(tx, method, externalRef);
        expect(await answer(tx, () => tx.subscriptionPayment.update({ where: { id: p.id },
          data: { status: 'EXPIRED', failureCode: 'DISPATCH_REVOKED', clientKey: voided(p), externalRef } })))
          .toMatch(/Confirmation source ownership is immutable/);
      });
    });
});

describe('a released checkout pause reopens only for a person, only while HELD, only for its own obligation', () => {
  async function releasedCheckout(tx: Prisma.TransactionClient) {
    const f = await vendorFee(tx);
    const checkout = await tx.mmgCheckoutIntent.create({ data: { tenantId: f.clock.tenantId, subscriptionId: f.sub.id,
      merchantTransactionId: `${Date.now()}${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}`, amount: 20000, currencyCode: 'GYD',
      createdByUserId: f.user.id, platform: 'ios', status: 'NOT_PAID', reason: 'MMG_RESULT_2',
      checkoutUrlSealed: Buffer.alloc(40), checkoutUrlDek: Buffer.alloc(40), expiresAt: new Date(Date.now() + 30 * 60_000) } });
    await beginConfirmationInTx(tx, f.sub.id, { checkoutId: checkout.id }, 'MMG_CHECKOUT_PENDING', new Date());
    await resolveConfirmationInTx(tx, f.sub.id, { checkoutId: checkout.id }, 'PROVEN_UNPAID', { actor: 'mmg-checkout-reply', reference: 'MMG_RESULT_2' }, new Date());
    const hold = await tx.paymentConfirmationHold.findUniqueOrThrow({ where: { checkoutId: checkout.id } });
    return { f, checkout, hold };
  }
  const reopen = (tx: Prisma.TransactionClient, hold: { id: string; resolutionHistory: Prisma.JsonValue; sourceEpoch: number },
    history: Array<Record<string, unknown>> = [{ status: 'LATE_POSITIVE_REVIEW', at: new Date().toISOString(), reason: 'REFERENCE_NOT_ECHOED', epoch: hold.sourceEpoch }]) =>
    tx.paymentConfirmationHold.update({ where: { id: hold.id }, data: { status: 'ACTIVE', reason: 'LATE_POSITIVE_REVIEW',
      resolvedAt: null, resolvedBy: null, resolutionEvidence: null,
      resolutionHistory: [...(hold.resolutionHistory as Array<Record<string, unknown>>), ...history] as Prisma.InputJsonValue } });

  it('a HELD checkout of the current obligation reopens with one LATE_POSITIVE_REVIEW entry', async () => {
    await rolledBack(async (tx) => {
      const { checkout, hold } = await releasedCheckout(tx);
      await tx.mmgCheckoutIntent.update({ where: { id: checkout.id }, data: { status: 'HELD', reason: 'REFERENCE_NOT_ECHOED' } });
      expect(await answer(tx, () => reopen(tx, hold))).toBeNull();
    });
  });
  it('a checkout that is not HELD cannot reopen its pause', async () => {
    await rolledBack(async (tx) => {
      const { hold } = await releasedCheckout(tx);
      expect(await answer(tx, () => reopen(tx, hold))).toMatch(/exact verified positive correction/);
    });
  });
  it('only a LATE_POSITIVE_REVIEW entry reopens it', async () => {
    await rolledBack(async (tx) => {
      const { checkout, hold } = await releasedCheckout(tx);
      await tx.mmgCheckoutIntent.update({ where: { id: checkout.id }, data: { status: 'HELD' } });
      expect(await answer(tx, () => reopen(tx, hold, [{ status: 'REOPENED', at: new Date().toISOString(), epoch: hold.sourceEpoch }])))
        .toMatch(/exact verified positive correction/);
    });
  });
  it('a payment pause never reopens this way', async () => {
    await rolledBack(async (tx) => {
      const f = await vendorFee(tx);
      const payment = await tx.subscriptionPayment.create({ data: { subscriptionId: f.sub.id, amount: 20000, paymentMethod: 'MOBILE_MONEY',
        status: 'UNKNOWN', periodStart: f.due, periodEnd: f.end, clientKey: `sub:${f.sub.id}:${f.periodKey}:a0` } });
      await beginConfirmationInTx(tx, f.sub.id, { paymentId: payment.id }, 'PAYMENT_DISPATCHED', new Date());
      await resolveConfirmationInTx(tx, f.sub.id, { paymentId: payment.id }, 'PROVEN_UNPAID', { actor: 'test', reference: 'declined' }, new Date());
      const hold = await tx.paymentConfirmationHold.findUniqueOrThrow({ where: { paymentId: payment.id } });
      expect(await answer(tx, () => reopen(tx, hold))).toMatch(/exact verified positive correction/);
    });
  });
  it('an older obligation never reopens: the clock has moved to a paid next week', async () => {
    await rolledBack(async (tx) => {
      const { f, checkout, hold } = await releasedCheckout(tx);
      await tx.mmgCheckoutIntent.update({ where: { id: checkout.id }, data: { status: 'HELD' } });
      // The owed week is paid another way and the clock advances (epoch 2).
      expect(await paidTransition(tx, f, { currency: 'GYD' })).toBeNull();
      const clock = await tx.billingDunningClock.findUniqueOrThrow({ where: { id: f.clock.id } });
      await tx.billingDunningClock.update({ where: { id: clock.id }, data: { dueAt: f.end, epoch: 2, version: { increment: 1 }, elapsedMs: 0n,
        runningSince: f.end, pausedAt: null, resumedAt: null, retryAtMs: 0n, nudgeAtMs: null, churnAtMs: null } });
      expect(await answer(tx, () => reopen(tx, hold))).toMatch(/exact verified positive correction/);
    });
  });
});
