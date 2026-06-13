import type { PrismaClient, Subscription, SubscriptionType, Prisma } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';

// ---------------------------------------------------------------------------
// SubscriptionService — the one place a subscription is BORN, and it is always
// born as a free trial the moment a payer goes live (vendor approved, rider or
// driver documents verified). The trial is the only entry into billing:
//   verify -> 14-day TRIAL (never charged) -> auto-convert to ACTIVE on expiry
//   -> the existing BillingService cycle takes over (charge, grace, suspend).
// Deterministic code only (hard rule 1); no money moves here — conversion just
// flips status and hands the subscription to the weekly cycle.
// ---------------------------------------------------------------------------

const TRIAL_DAYS = 14;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Heads-up window before a trial ends. */
const TRIAL_ENDING_REMINDER_DAYS = 3;

export interface TrialResult {
  /** false when a subscription already existed (idempotent re-verification). */
  created: boolean;
  subscription: Subscription;
}

export class SubscriptionService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
  ) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  // -------------------------------------------------------------------------
  // Trial start — called from the verification/approval hooks
  // -------------------------------------------------------------------------

  async startTrialForRider(riderId: string, now = new Date()): Promise<TrialResult | null> {
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { id: true, user: { select: { id: true, countryCode: true } } },
    });
    if (!rider) return null;
    return this.start({ link: { riderId }, type: 'DELIVERY_RIDER' }, rider.user.id, rider.user.countryCode, 'mover', now);
  }

  async startTrialForDriver(driverId: string, now = new Date()): Promise<TrialResult | null> {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, user: { select: { id: true, countryCode: true } } },
    });
    if (!driver) return null;
    return this.start({ link: { driverId }, type: 'TAXI_DRIVER' }, driver.user.id, driver.user.countryCode, 'mover', now);
  }

  async startTrialForVendor(vendorId: string, now = new Date()): Promise<TrialResult | null> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, vendorType: true, owner: { select: { userId: true, user: { select: { countryCode: true } } } } },
    });
    if (!vendor) return null;
    // STORE/SERVICE have no dedicated SubscriptionType yet; they bill at the
    // small-vendor rate, so bucket them under RESTAURANT for the type label.
    const type: SubscriptionType = vendor.vendorType === 'SUPERMARKET' ? 'SUPERMARKET' : 'RESTAURANT';
    return this.start(
      { link: { vendorId }, type },
      vendor.owner.userId,
      vendor.owner.user.countryCode,
      'smallVendor',
      now,
    );
  }

  /** Idempotent: a subscription already exists for this entity -> no-op. */
  private async start(
    opts: { link: { riderId: string } | { driverId: string } | { vendorId: string }; type: SubscriptionType },
    payerUserId: string,
    countryCode: string,
    rateKey: 'mover' | 'smallVendor',
    now: Date,
  ): Promise<TrialResult> {
    const existing = await this.prisma.subscription.findUnique({ where: opts.link });
    if (existing) return { created: false, subscription: existing };

    const config = await this.countryConfig.getByCode(countryCode);
    const tiers = await this.countryConfig.getSubscriptionTiers(countryCode);
    const weeklyRate = tiers[rateKey];
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);

    let subscription: Subscription;
    try {
      subscription = await this.prisma.subscription.create({
        data: {
          ...opts.link,
          type: opts.type,
          status: 'TRIAL',
          isTrialActive: true,
          trialEndDate: trialEnd,
          weeklyRate,
          currencyCode: config.currencyCode,
          billingMethod: 'CASH',
          currentPeriodStart: now,
          currentPeriodEnd: trialEnd,
          // First charge is due the instant the trial ends; the weekly cycle
          // (which only bills ACTIVE) picks it up after convertExpiredTrials.
          nextBillingDate: trialEnd,
        },
      });
    } catch (error) {
      // Lost a race with a concurrent verification — the unique entity key held
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        return { created: false, subscription: await this.prisma.subscription.findUniqueOrThrow({ where: opts.link }) };
      }
      throw error;
    }

    await this.notifications.send({
      userId: payerUserId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Your 14-day free trial has started 🎉',
      body: `Welcome to Swift! You have full access free until ${trialEnd.toISOString().slice(0, 10)}. After that your weekly fee of $${weeklyRate.toLocaleString()} ${config.currencyCode} begins.`,
      data: { kind: 'trial_started', subscriptionId: subscription.id, trialEndDate: trialEnd.toISOString() },
    });

    return { created: true, subscription };
  }

  // -------------------------------------------------------------------------
  // Trial lifecycle — daily job
  // -------------------------------------------------------------------------

  /** Expired trials become ACTIVE and due, then the weekly cycle bills them. */
  async convertExpiredTrials(now = new Date()): Promise<number> {
    const expired = await this.prisma.subscription.findMany({
      where: { status: 'TRIAL', trialEndDate: { lte: now } },
      include: this.payerInclude,
    });

    let converted = 0;
    for (const sub of expired) {
      const periodStart = sub.trialEndDate ?? now;
      const periodEnd = new Date(periodStart.getTime() + WEEK_MS);
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          isTrialActive: false,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextBillingDate: periodStart, // due now — billed on the next cycle run
        },
      });
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Your free trial has ended',
        body: `Your 14-day trial is over. Your weekly fee of $${Number(sub.weeklyRate).toLocaleString()} ${sub.currencyCode} is now due — top up or add a card to stay active.`,
        data: { kind: 'trial_ended', subscriptionId: sub.id },
      });
      converted += 1;
    }
    return converted;
  }

  /** One reminder per trial, in the final days before it ends. */
  async sendTrialEndingReminders(now = new Date()): Promise<number> {
    const soon = new Date(now.getTime() + TRIAL_ENDING_REMINDER_DAYS * DAY_MS);
    const ending = await this.prisma.subscription.findMany({
      where: { status: 'TRIAL', trialEndDate: { gt: now, lte: soon } },
      include: this.payerInclude,
    });

    let sent = 0;
    for (const sub of ending) {
      try {
        // The unique idempotencyKey makes the reminder exactly-once per trial.
        await this.prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'REMINDER',
            amount: sub.weeklyRate,
            currencyCode: sub.currencyCode,
            idempotencyKey: `trial-ending:${sub.id}`,
            note: 'Trial ending reminder',
          },
        });
      } catch (error) {
        if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') continue;
        throw error;
      }

      const daysLeft = Math.max(1, Math.ceil(((sub.trialEndDate ?? now).getTime() - now.getTime()) / DAY_MS));
      await this.notifications.send({
        userId: this.payerUserId(sub),
        type: 'SYSTEM_ANNOUNCEMENT',
        title: `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        body: `After your trial, your weekly fee of $${Number(sub.weeklyRate).toLocaleString()} ${sub.currencyCode} begins. Add a payment method to keep your account active.`,
        data: { kind: 'trial_ending', subscriptionId: sub.id, daysLeft },
      });
      sent += 1;
    }
    return sent;
  }

  private readonly payerInclude = {
    rider: { select: { userId: true } },
    driver: { select: { userId: true } },
    vendor: { select: { owner: { select: { userId: true } } } },
  } as const;

  private payerUserId(sub: {
    rider: { userId: string } | null;
    driver: { userId: string } | null;
    vendor: { owner: { userId: string } } | null;
  }): string {
    const userId = sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId;
    if (!userId) throw new Error('Subscription has no payer');
    return userId;
  }
}
