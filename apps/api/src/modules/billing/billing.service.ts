import type { PrismaClient, Subscription, Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';
import type { PaymentProvider } from '../../providers/payment/payment-provider';
import { getMmgProvider } from '../../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// BillingService — the one place V1 touches money: Swift's own weekly fee.
// Deterministic code only (hard rule 1). Every money event lands in the
// append-only BillingEvent log; the unique idempotencyKey is the DB-level
// double-charge guard, safe under concurrent job runs.
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 3;
const RETRY_HOURS = 24;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Catalogue size (active listings) at which a vendor moves to the large tier —
 *  1000+ items. Config can override per country. */
const DEFAULT_LARGE_CATALOGUE_THRESHOLD = 1000;

type SubWithRelations = Subscription & {
  rider: { userId: string } | null;
  driver: { userId: string } | null;
  vendor: { id: string; owner: { userId: string } } | null;
};

export interface BillingCycleResult {
  processed: number;
  succeeded: number;
  failed: number;
  suspended: number;
  skipped: number;
  errors: number;
  /** MMG merchant-initiated requests awaiting the payer's phone approval */
  pending: number;
}

export class BillingService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private payments: PaymentProvider,
  ) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  // -------------------------------------------------------------------------
  // The weekly cycle
  // -------------------------------------------------------------------------

  /** Bill everything due. One subscription's failure never kills the batch. */
  async runBillingCycle(now = new Date()): Promise<BillingCycleResult> {
    const due = await this.prisma.subscription.findMany({
      where: {
        autoRenew: true,
        OR: [
          { status: 'ACTIVE', nextBillingDate: { lte: now } },
          // Failed charges retry daily, while due — including SUSPENDED, so a
          // top-up between runs gets picked up even without the instant path
          { status: { in: ['PAST_DUE', 'SUSPENDED'] }, nextRetryAt: { lte: now } },
        ],
      },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });

    const result: BillingCycleResult = { processed: 0, succeeded: 0, failed: 0, suspended: 0, skipped: 0, errors: 0, pending: 0 };

    for (const sub of due) {
      result.processed += 1;
      try {
        const outcome = await this.billSubscription(sub as SubWithRelations, now);
        result[outcome] += 1;
      } catch {
        // Partial failure mid-batch: record and continue
        result.errors += 1;
      }
    }

    return result;
  }

  /**
   * Bill one subscription. Idempotent: the CHARGE_ATTEMPT event's unique key
   * (subscription + period + retry level) makes a second concurrent or
   * repeated run a no-op at the database level.
   */
  async billSubscription(
    sub: SubWithRelations,
    now = new Date(),
  ): Promise<'succeeded' | 'failed' | 'suspended' | 'skipped' | 'pending'> {
    const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
    const attemptKey = `charge:${sub.id}:${periodKey}:a${sub.failedAttempts}`;

    try {
      await this.prisma.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'CHARGE_ATTEMPT',
          amount: this.amountFor(sub),
          currencyCode: sub.currencyCode,
          idempotencyKey: attemptKey,
        },
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        return 'skipped'; // someone (or a concurrent run) already attempted this
      }
      throw error;
    }

    const amount = Number(this.amountFor(sub));

    // Waived subscriptions advance for free, with the audit trail intact
    if (sub.feeWaived || amount === 0) {
      await this.applySuccessfulCharge(sub, 0, 'fee-waived', now, periodKey);
      // A waive covers ONE period — the admin notice promises "for this period".
      // Clear it so normal billing resumes next cycle instead of a permanent free
      // ride (silent, recurring revenue loss). A genuinely $0 tier (amount===0,
      // feeWaived false) is NOT a waive and stays free.
      if (sub.feeWaived) {
        await this.prisma.subscription.update({ where: { id: sub.id }, data: { feeWaived: false } });
      }
      return 'succeeded';
    }

    const charged = await this.attemptCharge(sub, amount);

    if (charged.ok) {
      await this.applySuccessfulCharge(sub, amount, charged.ref, now, periodKey);
      return 'succeeded';
    }

    if ('pendingTx' in charged) {
      // MMG merchant-initiated: the request is on the payer's phone. Record
      // the in-flight payment; the poller settles it either way. The retry
      // clock still advances so an ignored request becomes tomorrow's dunning
      // attempt instead of a same-hour duplicate ping.
      await this.prisma.subscriptionPayment.create({
        data: {
          subscriptionId: sub.id,
          amount,
          status: 'PENDING',
          paymentMethod: sub.billingMethod,
          externalRef: charged.pendingTx,
          periodStart: sub.nextBillingDate,
          periodEnd: new Date(sub.nextBillingDate.getTime() + WEEK_MS),
        },
      });
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { nextRetryAt: new Date(now.getTime() + RETRY_HOURS * 60 * 60 * 1000) },
      });
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Approve your weekly fee in MMG',
        body: `We sent an MMG request for $${amount.toLocaleString()} ${sub.currencyCode}. Approve it on your phone to stay active.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_mmg_pending', subscriptionId: sub.id },
      });
      return 'pending';
    }

    return this.applyFailedCharge(sub, amount, charged.reason, now, periodKey);
  }

  private amountFor(sub: Subscription): Prisma.Decimal | number {
    return sub.customRate ?? sub.weeklyRate;
  }

  /** Prepaid balance settles FIRST (money already in hand); otherwise CARD
   *  charges the stored token and MOBILE_MONEY pushes an MMG request the payer
   *  approves on their phone. */
  private async attemptCharge(
    sub: SubWithRelations,
    amount: number,
  ): Promise<{ ok: true; ref: string } | { ok: false; reason: string } | { ok: false; pendingTx: string }> {
    // Prepaid balance is money Swift already holds — spend it before pinging any
    // external rail. Atomic conditional decrement (no read-then-write race). This
    // is also what makes an admin top-up reinstate a CARD/MMG sub: the recorded
    // cash settles the fee instead of firing a fresh (and duplicate) external
    // charge while the top-up sits unused and the partner stays suspended.
    const prepaid = await this.prisma.prepaidBalance.updateMany({
      where: { subscriptionId: sub.id, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (prepaid.count === 1) return { ok: true, ref: 'prepaid' };

    if (sub.billingMethod === 'CARD' && sub.paymentToken) {
      const result = await this.payments.chargeToken({
        token: sub.paymentToken,
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: `prov:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`,
        description: `Swift weekly subscription (${sub.type})`,
      });
      return result.status === 'succeeded'
        ? { ok: true, ref: result.providerRef }
        : { ok: false, reason: result.reason ?? 'Charge declined' };
    }

    if (sub.billingMethod === 'MOBILE_MONEY' && sub.mmgPayerMsisdn) {
      // §13 MMG rail — merchant-initiated. Amounts are minor units at the
      // provider seam; the reference doubles as the retry-safe correlation id.
      const result = await getMmgProvider().initiatePayment({
        payerId: sub.mmgPayerMsisdn,
        amountMinor: Math.round(amount * 100),
        currencyCode: sub.currencyCode,
        reference: `sub:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`,
      });
      if (result.status === 'approved') return { ok: true, ref: result.transactionId };
      if (result.status === 'pending' && result.transactionId) return { ok: false, pendingTx: result.transactionId };
      return { ok: false, reason: result.reason ?? 'MMG request failed' };
    }

    // Prepaid already tried and came up short above; no usable external rail
    // (a CASH sub with an empty balance, or a CARD/MMG sub missing credentials).
    return { ok: false, reason: 'Insufficient prepaid balance' };
  }

  private async applySuccessfulCharge(
    sub: SubWithRelations,
    amount: number,
    paymentRef: string,
    now: Date,
    periodKey: string,
    /** Settle an existing PENDING payment row (MMG poll path) instead of creating one. */
    settlePaymentId?: string,
  ) {
    const periodStart = sub.nextBillingDate;
    const periodEnd = new Date(periodStart.getTime() + WEEK_MS);
    const wasInterrupted = sub.status === 'PAST_DUE' || sub.status === 'SUSPENDED';

    if (settlePaymentId) {
      await this.prisma.subscriptionPayment.update({
        where: { id: settlePaymentId },
        data: { status: 'CAPTURED', paidAt: now },
      });
    } else {
      await this.prisma.subscriptionPayment.create({
        data: {
          subscriptionId: sub.id,
          amount,
          status: 'CAPTURED',
          paymentMethod: sub.billingMethod,
          externalRef: paymentRef,
          periodStart,
          periodEnd,
          paidAt: now,
        },
      });
    }

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        lastPaymentDate: now,
        failedAttempts: 0,
        nextRetryAt: null,
        isInGracePeriod: false,
        gracePeriodEnd: null,
      },
    });

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'CHARGE_SUCCESS',
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: `success:${sub.id}:${periodKey}`,
        paymentRef,
      },
    });

    if (wasInterrupted) {
      await this.reinstate(sub, periodKey);
    }

    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription payment received',
      body: `$${amount.toLocaleString()} ${sub.currencyCode} received. You are active until ${periodEnd.toISOString().slice(0, 10)}.`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_success', subscriptionId: sub.id },
    });
  }

  /**
   * §13 MMG rail poller (BullMQ repeatable, ~2 min): settle every in-flight
   * merchant-initiated request. Approved → the period advances off the SAME
   * pending payment row (no duplicate). Declined/expired — or older than 24h —
   * → the normal dunning path (PAST_DUE → retries → suspend). Still-pending
   * stays pending; the payer's phone is the clock, the DB is the truth.
   */
  async pollPendingMmgCharges(now = new Date()): Promise<{ settled: number; failed: number; stillPending: number }> {
    const pending = await this.prisma.subscriptionPayment.findMany({
      where: { status: 'PENDING', paymentMethod: 'MOBILE_MONEY', externalRef: { not: null } },
      take: 200,
    });
    const out = { settled: 0, failed: 0, stillPending: 0 };
    if (pending.length === 0) return out;

    const mmg = getMmgProvider();
    for (const payment of pending) {
      const sub = await this.prisma.subscription.findUnique({
        where: { id: payment.subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      if (!sub) continue;
      const periodKey = payment.periodStart.toISOString().slice(0, 10);

      let status: string;
      try {
        status = (await mmg.transactionLookup({ transactionId: payment.externalRef! })).status;
      } catch {
        out.stillPending += 1; // transport hiccup — the next tick retries
        continue;
      }

      const expired =
        status === 'expired' ||
        (status === 'pending' && now.getTime() - payment.createdAt.getTime() > 24 * 60 * 60 * 1000);

      if (status === 'approved') {
        await this.applySuccessfulCharge(sub as SubWithRelations, Number(payment.amount), payment.externalRef!, now, periodKey, payment.id);
        out.settled += 1;
      } else if (status === 'declined' || status === 'reversed' || expired) {
        await this.prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
        await this.applyFailedCharge(sub as SubWithRelations, Number(payment.amount), `MMG request ${expired ? 'expired unapproved' : status}`, now, periodKey);
        out.failed += 1;
      } else {
        out.stillPending += 1;
      }
    }
    return out;
  }

  /**
   * §13 rail selection — one place flips how a subscription pays. CASH is the
   * prepaid path; MOBILE_MONEY needs the payer's MMG account. CARD enrollment
   * stays with the tokenization flow, not here.
   */
  async setBillingRail(subscriptionId: string, method: 'CASH' | 'MOBILE_MONEY', mmgPayerMsisdn?: string) {
    if (method === 'MOBILE_MONEY' && !mmgPayerMsisdn?.trim()) {
      throw new AppError(400, 'MSISDN_REQUIRED', 'Your MMG account number is required to pay the weekly fee via MMG.');
    }
    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        billingMethod: method,
        mmgPayerMsisdn: method === 'MOBILE_MONEY' ? mmgPayerMsisdn!.trim() : null,
      },
    });
    await this.prisma.billingEvent.create({
      data: {
        subscriptionId,
        type: 'TIER_CHANGE',
        currencyCode: updated.currencyCode,
        idempotencyKey: `rail:${subscriptionId}:${Date.now()}`,
        note: `Billing rail set to ${method}${method === 'MOBILE_MONEY' ? ' (MMG merchant-initiated)' : ' (prepaid)'}`,
      },
    });
    return updated;
  }

  private async applyFailedCharge(
    sub: SubWithRelations,
    amount: number,
    reason: string,
    now: Date,
    periodKey: string,
  ): Promise<'failed' | 'suspended'> {
    const attempts = sub.failedAttempts + 1;
    const willSuspend = attempts >= MAX_FAILED_ATTEMPTS && sub.autoSuspendEnabled;

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'CHARGE_FAILED',
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: `failed:${sub.id}:${periodKey}:a${sub.failedAttempts}`,
        note: reason,
      },
    });

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: willSuspend ? 'SUSPENDED' : 'PAST_DUE',
        failedAttempts: attempts,
        nextRetryAt: new Date(now.getTime() + RETRY_HOURS * 60 * 60 * 1000),
        isInGracePeriod: !willSuspend,
        gracePeriodEnd: willSuspend ? null : new Date(now.getTime() + RETRY_HOURS * 60 * 60 * 1000),
      },
    });

    if (willSuspend) {
      await this.suspendAccess(sub, periodKey);
      return 'suspended';
    }

    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription payment failed',
      body: `${reason}. We will retry tomorrow (attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}). Top up or update your card to stay active.`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_failed', subscriptionId: sub.id },
    });
    return 'failed';
  }

  // -------------------------------------------------------------------------
  // Suspend / reinstate
  // -------------------------------------------------------------------------

  /** Suspension removes the payer from the platform until they pay. */
  private async suspendAccess(sub: SubWithRelations, periodKey: string) {
    if (sub.vendor) {
      // SUSPENDED vendors vanish from customer browse (which filters ACTIVE)
      await this.prisma.vendor.update({
        where: { id: sub.vendor.id },
        data: { status: 'SUSPENDED', acceptingOrders: false },
      });
    }
    if (sub.rider) {
      await this.prisma.rider.updateMany({
        where: { userId: sub.rider.userId },
        data: { isOnline: false, isAvailable: false },
      });
    }
    if (sub.driver) {
      await this.prisma.driver.updateMany({
        where: { userId: sub.driver.userId },
        data: { isOnline: false, isAvailable: false },
      });
    }

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'SUSPENDED',
        currencyCode: sub.currencyCode,
        idempotencyKey: `suspended:${sub.id}:${periodKey}`,
        note: `Auto-suspended after ${MAX_FAILED_ATTEMPTS} failed charges`,
      },
    });

    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription suspended',
      body: 'Your subscription is unpaid and your access is suspended. Top up or pay to be reinstated instantly.',
      audience: this.payerAudience(sub),
      data: { kind: 'billing_suspended', subscriptionId: sub.id },
    });
  }

  private async reinstate(sub: SubWithRelations, periodKey: string) {
    if (sub.vendor) {
      await this.prisma.vendor.update({
        where: { id: sub.vendor.id },
        data: { status: 'ACTIVE', acceptingOrders: true },
      });
    }

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId: sub.id,
        type: 'REINSTATED',
        currencyCode: sub.currencyCode,
        idempotencyKey: `reinstated:${sub.id}:${periodKey}:${Date.now()}`,
        note: 'Payment received — access restored',
      },
    });

    await this.notifications.send({
      userId: this.payerUserId(sub),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Subscription reinstated',
      body: 'Payment received — welcome back. Your access is restored.',
      audience: this.payerAudience(sub),
      data: { kind: 'billing_reinstated', subscriptionId: sub.id },
    });
  }

  // -------------------------------------------------------------------------
  // Prepaid top-ups (manual confirm in admin for now)
  // -------------------------------------------------------------------------

  async recordTopUp(subscriptionId: string, amount: number, recordedBy: string, reference?: string) {
    if (amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Top-up must be positive');

    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });
    if (!sub) throw new NotFoundError('Subscription', subscriptionId);

    const balance = await this.prisma.prepaidBalance.upsert({
      where: { subscriptionId },
      update: { balance: { increment: amount } },
      create: { subscriptionId, balance: amount, currencyCode: sub.currencyCode },
    });

    await this.prisma.billingEvent.create({
      data: {
        subscriptionId,
        type: 'PREPAID_TOPUP',
        amount,
        currencyCode: sub.currencyCode,
        idempotencyKey: `topup:${subscriptionId}:${Date.now()}:${recordedBy}`,
        note: reference ? `ref: ${reference} (by ${recordedBy})` : `recorded by ${recordedBy}`,
      },
    });

    await this.notifications.send({
      userId: this.payerUserId(sub as SubWithRelations),
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Top-up received',
      body: `$${amount.toLocaleString()} ${sub.currencyCode} added to your subscription balance.`,
      audience: this.payerAudience(sub),
      data: { kind: 'billing_topup', subscriptionId },
    });

    // A top-up while behind triggers an instant billing attempt — paying
    // reinstates immediately, no waiting for the next cycle
    if (sub.status === 'PAST_DUE' || sub.status === 'SUSPENDED') {
      const fresh = await this.prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
        include: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      await this.billSubscription(fresh as SubWithRelations);
    }

    return balance;
  }

  // -------------------------------------------------------------------------
  // Reminders & tier recalculation
  // -------------------------------------------------------------------------

  /** One reminder per subscription per period, 24h before the due date. */
  async sendUpcomingReminders(now = new Date()): Promise<number> {
    const dayAhead = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const upcoming = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', autoRenew: true, nextBillingDate: { gt: now, lte: dayAhead } },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });

    let sent = 0;
    for (const sub of upcoming) {
      const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
      try {
        await this.prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'REMINDER',
            amount: this.amountFor(sub),
            currencyCode: sub.currencyCode,
            idempotencyKey: `reminder:${sub.id}:${periodKey}`,
          },
        });
      } catch (error) {
        if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') continue; // already reminded
        throw error;
      }

      await this.notifications.send({
        userId: this.payerUserId(sub as SubWithRelations),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Subscription due tomorrow',
        body: `Your weekly fee of $${Number(this.amountFor(sub)).toLocaleString()} ${sub.currencyCode} is due tomorrow.`,
        audience: this.payerAudience(sub),
        data: { kind: 'billing_reminder', subscriptionId: sub.id },
      });
      sent += 1;
    }
    return sent;
  }

  /**
   * Weekly tier check: vendor tier comes from catalogue size (active listing
   * count) and CountryConfig rates — NEVER from sales (zero-commission model).
   */
  async recalculateVendorTiers(): Promise<number> {
    const vendorSubs = await this.prisma.subscription.findMany({
      where: { vendorId: { not: null }, status: { in: ['ACTIVE', 'PAST_DUE', 'TRIAL'] } },
      include: {
        vendor: {
          select: { id: true, owner: { select: { user: { select: { countryCode: true, id: true } } } } },
        },
      },
    });

    let changed = 0;
    for (const sub of vendorSubs) {
      if (!sub.vendor) continue;
      const tiers = await this.countryConfig.getSubscriptionTiers(sub.vendor.owner.user.countryCode);
      const threshold = tiers['largeCatalogueThreshold'] ?? DEFAULT_LARGE_CATALOGUE_THRESHOLD;

      const activeListings = await this.prisma.item.count({
        where: { vendorId: sub.vendor.id, isAvailable: true },
      });
      // "1000+ items" → large: the threshold count itself qualifies.
      const isLarge = activeListings >= threshold;
      const targetRate = isLarge ? tiers.largeVendor : tiers.smallVendor;

      if (Number(sub.weeklyRate) !== targetRate) {
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { weeklyRate: targetRate },
        });
        await this.prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'TIER_CHANGE',
            amount: targetRate,
            currencyCode: sub.currencyCode,
            idempotencyKey: `tier:${sub.id}:${new Date().toISOString().slice(0, 10)}:${targetRate}`,
            note: `${activeListings} active listings -> ${isLarge ? 'large' : 'small'} tier`,
          },
        });
        changed += 1;
      }
    }
    return changed;
  }

  private payerUserId(sub: SubWithRelations): string {
    const userId = sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId;
    if (!userId) throw new AppError(500, 'ORPHAN_SUBSCRIPTION', `Subscription ${sub.id} has no payer`);
    return userId;
  }

  /** Billing notices belong to the surface that pays the fee. */
  private payerAudience(sub: SubWithRelations): 'earner' | 'business' {
    return sub.vendor ? 'business' : 'earner';
  }
}
