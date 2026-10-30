import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { readFeePause } from '../billing/mmg-pause';
import { proAgreementAccepted, proAgreementState } from '../legal/reaccept';
import { publishLegalDocumentOnce, recordConsent, type ConsentSurface } from '../legal/consent.service';
import {
  assertSawQuote, assertWeeklyFeeAck, signupQuote, WEEKLY_FEE_ACK_TEXT_V1, WEEKLY_FEE_ACK_TYPE, WEEKLY_FEE_ACK_VERSION, type WeeklyFeeAck,
} from '../partner/weekly-fee-ack';
import { subscriptionOperability, type OperabilitySubscription, type SubscriptionOperability } from '../subscription/operate-gate';
import { liveServicesStoreFeeWhere } from '../subscription/subscription-owner';

// ---------------------------------------------------------------------------
// [BILL-PRO PR3 · owner 28 Oct 2026 Rounds A+B] THE PRO WEEKLY FEE: when a pro's fee is born, and whether a pro may
// take NEW work. One module, behind one switch.
//
// PRO_WEEKLY_FEE (exactly "1", blanks ignored) is OFF by default. Off: nothing here is born and nothing is gated, so
// every pro answer is what it was before (owner B4: on only after Apple approves build 12, the pro-fee OTA and the
// website block are live, a staging run passes, and the owner says go).
//
// On:
//  - A pro's fee is born (SubscriptionService, the trial law: 14 days, one trial per person per role
//    SERVICE_PROVIDER, A2) once ALL hold: their documents are approved (the live verification), they accepted the
//    Business Agreement that covers Providers (legal/reaccept.ts PRO_AGREEMENT_VERSION: never charged without the
//    tick, A1/A3) AND ticked "I understand the weekly fee" as a pro (B3: the fee words and the amount they saw, in
//    the consent ledger, as at partner sign-up), and they own no Services store whose fee is live (one fee, B1). Birth is tried after a document
//    event, after the pro's tick, by the daily reconcile sweep, and hourly by the billing job's switch-on pass
//    (birthDueProFees), so a pro who ticked before the switch was turned on is born within the hour of it (their
//    trial then starts on that day: the LATER of the switch and their ticks, owner 30 Oct 00:14Z; never a trial that
//    already ran, and nobody pays sooner than 14 days after being told).
//  - New work (being listed, a request, a quote, a customer's schedule, a confirm, a booking from their list, their
//    public portfolio photos) needs `proFeeStanding(...).operable`: the agreement accepted, and the fee that covers
//    them operable by THE canOperate predicate (operate-gate.ts: trial or active, past due only within the 48-hour
//    grace; fee-pause holds it). The fee that covers a pro is their own, else (B1) their own Services store's fee
//    while it is live. Work already booked is never gated (start, complete, cancel, a move, chat): the vendor
//    IN_FLIGHT rule (B2).
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

/** PRO_WEEKLY_FEE: on only when exactly "1" (surrounding blanks ignored). */
export function proWeeklyFeeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['PRO_WEEKLY_FEE'] ?? '').trim() === '1';
}

const OPERABILITY_SELECT = {
  id: true, status: true, gracePeriodEnd: true, autoRenew: true, currentPeriodEnd: true,
  billingConfirmationPausedAt: true, billingEnforcementDueAt: true, autoSuspendEnabled: true,
} as const satisfies Prisma.SubscriptionSelect;


/** [B1] The person's own Services store fee that is still live (one fee covers their pro profile), or null. */
export async function liveServicesStoreFee(db: Db, userId: string): Promise<OperabilitySubscription | null> {
  return db.subscription.findFirst({ where: liveServicesStoreFeeWhere(userId), orderBy: { vendorId: 'asc' }, select: OPERABILITY_SELECT });
}

export type ProFeeStanding =
  | { required: false; operable: true }
  | {
    required: true;
    operable: boolean;
    /** Why new work is refused: no accepted agreement, or the fee's own refusal (operate-gate). */
    why: 'AGREEMENT' | 'FEE_TERMS' | Exclude<SubscriptionOperability, { operable: true }>['why'] | null;
    /** Which fee covers the pro: their own, their Services store's (one fee), or none yet. */
    source: 'OWN' | 'STORE' | null;
    subscriptionId: string | null;
  };

/** May this pro (by their user id) take NEW work right now? See the header. */
export async function proFeeStanding(db: Db, userId: string, now = new Date(), env: Record<string, string | undefined> = process.env): Promise<ProFeeStanding> {
  if (!proWeeklyFeeEnabled(env)) return { required: false, operable: true };
  if (!proAgreementAccepted(await proAgreementState(db, userId))) {
    return { required: true, operable: false, why: 'AGREEMENT', source: null, subscriptionId: null };
  }
  if (!(await proFeeAcknowledged(db, userId))) {
    return { required: true, operable: false, why: 'FEE_TERMS', source: null, subscriptionId: null };
  }
  const own = await db.serviceProvider.findUnique({ where: { userId }, select: { subscription: { select: OPERABILITY_SELECT } } });
  const store = await liveServicesStoreFee(db, userId);
  // [B1] While the person's own Services store fee is live it is the one fee; otherwise their own pro fee.
  const [source, sub] = store ? ['STORE' as const, store] : own?.subscription ? ['OWN' as const, own.subscription] : [null, null];
  const verdict = subscriptionOperability(sub, { missingRow: 'BLOCK' }, await readFeePause(db, env, sub?.id), now);
  return verdict.operable
    ? { required: true, operable: true, why: null, source, subscriptionId: sub?.id ?? null }
    : { required: true, operable: false, why: verdict.why, source, subscriptionId: sub?.id ?? null };
}

/** The pro can't take new work (the customer's words: they can't take bookings right now). */
export const PRO_FEE_REFUSED_CODE = 'PROVIDER_FEE_UNPAID';
export const PRO_FEE_CUSTOMER_MESSAGE = 'This provider can’t take bookings right now. Choose another provider, or try again later.';

/** The pro's own words: what to do to take new work again. */
export function proFeeProviderMessage(standing: ProFeeStanding): string {
  if (standing.required && standing.why === 'AGREEMENT') {
    return 'Accept the Business Agreement in the app to take new work.';
  }
  if (standing.required && standing.why === 'FEE_TERMS') {
    return 'Read the weekly fee and tick “I understand the weekly fee” to take new work.';
  }
  return 'Pay this week’s fee in the Swift app or on the Swift website to take new work. Jobs already booked can still go ahead.';
}

/** Refuses NEW work (409) unless the pro's fee standing allows it. `audience` picks the words. */
export async function assertProFeeAllowsNewWork(db: Db, userId: string, audience: 'customer' | 'provider', now = new Date()): Promise<void> {
  const standing = await proFeeStanding(db, userId, now);
  if (standing.operable) return;
  throw new AppError(409, PRO_FEE_REFUSED_CODE, audience === 'customer' ? PRO_FEE_CUSTOMER_MESSAGE : proFeeProviderMessage(standing));
}

/** Why a pro's fee is not born (yet). */
export const PRO_FEE_NOT_DUE = 'PRO_FEE_NOT_DUE';

/**
 * Try to bring a pro's weekly fee into being (see the header). Idempotent: returns the existing subscription's id,
 * the new one's, or null when it is not due (switch off, not verified, no accepted agreement, one fee through a
 * Services store, the review fiction). Every condition is re-read inside the activation transaction, under the
 * identity lock that orders every activation. Never throws for "not due"; other failures are logged and left to the
 * reconcile sweep.
 */
export async function ensureProFeeBorn(prisma: PrismaClient, userId: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (!proWeeklyFeeEnabled(env)) return null;
  const pro = await prisma.serviceProvider.findUnique({ where: { userId }, select: { id: true, isVerified: true, subscription: { select: { id: true } } } });
  if (!pro) return null;
  if (pro.subscription) return pro.subscription.id;
  if (!pro.isVerified) return null;
  const { SubscriptionService } = await import('../subscription/subscription.service');
  const subscriptions = new SubscriptionService(prisma);
  try {
    if (await subscriptions.isFiction({ serviceProviderId: pro.id })) return null;
    const sub = await subscriptions.startTrialForServiceProvider(pro.id);
    return sub.id;
  } catch (error) {
    if (error instanceof AppError && error.code === PRO_FEE_NOT_DUE) return null;
    log().error({ err: error, serviceProviderId: pro.id }, '[BILL-PRO] pro weekly fee birth failed; the reconcile sweep retries');
    return null;
  }
}

/**
 * [BILL-PRO · REVIEW-F #2225 S3-2 · owner 30 Oct 2026 00:14Z] THE SWITCH-ON PASS. A pro who ticked both before the
 * switch was turned on has no fee yet, and an unborn fee takes no new work (fail closed). Every pro without a fee is
 * tried here, from the hourly billing job, so they are born within the hour of the switch turning on (not at the
 * daily document sweep), and their 14-day trial starts at that birth: on the LATER of the switch and their own ticks,
 * never a trial that already ran. Off: nothing. Birth is idempotent and race-safe (ensureProFeeBorn).
 */
export async function birthDueProFees(
  prisma: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  batchSize = 200,
): Promise<{ tried: number; born: number }> {
  const out = { tried: 0, born: 0 };
  if (!proWeeklyFeeEnabled(env)) return out;
  let cursor: string | undefined;
  for (;;) {
    const pros = await prisma.serviceProvider.findMany({
      where: { isVerified: true, subscription: { is: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, userId: true },
    });
    if (pros.length === 0) return out;
    for (const pro of pros) {
      out.tried += 1;
      if (await ensureProFeeBorn(prisma, pro.userId, env)) out.born += 1;
    }
    cursor = pros[pros.length - 1]!.id;
  }
}

// ── [owner B3] "I understand the weekly fee", as a pro ──────────────────────────────────────────────────────────────

/** The path a pro's fee tick is recorded under (a store's or a mover's tick at sign-up is not a pro's). */
export const PRO_FEE_ACK_PATH = 'provider/weekly-fee-ack';

/** A pro's fee tick: the amount and currency the words were ticked to (evidence.weeklyFee). */
export interface ProFeeTick { amount: number; currencyCode: string }

/** The pro's LATEST "I understand the weekly fee" tick as a pro (the current words), or null when there is none, it was
 *  withdrawn, or it carries no amount. */
export async function latestProFeeTick(db: Db, userId: string): Promise<ProFeeTick | null> {
  const tick = await db.consentRecord.findFirst({
    where: { subjectId: userId, documentType: WEEKLY_FEE_ACK_TYPE, documentVersion: WEEKLY_FEE_ACK_VERSION, evidence: { path: ['path'], equals: PRO_FEE_ACK_PATH } },
    orderBy: { capturedAt: 'desc' },
    select: { action: true, evidence: true },
  });
  if (!tick || tick.action === 'withdrawn') return null;
  const fee = (tick.evidence as { weeklyFee?: { amount?: unknown; currencyCode?: unknown } } | null)?.weeklyFee;
  return typeof fee?.amount === 'number' && typeof fee.currencyCode === 'string' ? { amount: fee.amount, currencyCode: fee.currencyCode } : null;
}

/** [REVIEW-G #2230 S3-1 · owner B3] Was this tick given to exactly this fee (amount AND currency)? */
export function tickIsFor(tick: ProFeeTick | null, fee: ProFeeTick): boolean {
  return !!tick && tick.amount === fee.amount && tick.currencyCode === fee.currencyCode;
}

export interface ProFeeAckState {
  /** The pro's tick holds: see proFeeAckState. */
  acknowledged: boolean;
  /** What the pro is asked to tick now (the services rate: what the fee would be born at). */
  amount: number;
  currencyCode: string;
  /** The amount their latest tick was given to (null: never ticked, or withdrawn). */
  ticked: ProFeeTick | null;
  /** They ticked, but to another amount than the one asked now: ask again, naming the new amount. */
  changed: boolean;
}

/**
 * [REVIEW-G #2230 S3-1 · owner B3: "the amount they saw"] Does this pro's fee tick hold? A tick is consent to ONE
 * amount. Before the fee is born, it holds only when the pro's LATEST tick was given to the amount the fee would be
 * born at now (the services rate, proFeeQuote): if the rate changed after they ticked (say while the switch was off,
 * or while their documents waited), they are asked again at the new amount and nothing is born until they tick it
 * (birth re-checks the exact rate it writes: pro-fee-due.ts). Once the fee is born the tick that bore it holds: the
 * born fee's own price changes go through the told-in-advance fee-rise rules, never through this tick.
 * [REVIEW-G #2230 bd1e46f3 NEW S3-1 · owner B1] The same while their own Services store's fee is live and covers them
 * (one fee): any live tick holds, so a services-rate change never unlists a covered pro (the fee they pay is the
 * store's, whose price changes follow the 14-day fee-rise rule). Nothing is born at an unticked amount: when the
 * cover ends they are back to the quote above, and birth re-checks the exact rate it writes.
 */
export async function proFeeAckState(db: Db, userId: string): Promise<ProFeeAckState> {
  const ticked = await latestProFeeTick(db, userId);
  const quote = await proFeeQuote(db, userId);
  const own = await db.serviceProvider.findUnique({ where: { userId }, select: { subscription: { select: { id: true } } } });
  const held = own?.subscription ?? (await liveServicesStoreFee(db, userId));
  const acknowledged = held ? ticked !== null : tickIsFor(ticked, quote);
  return { acknowledged, amount: quote.amount, currencyCode: quote.currencyCode, ticked, changed: ticked !== null && !acknowledged };
}

/** Has this pro ticked "I understand the weekly fee" as a pro, and does that tick hold (proFeeAckState)? */
export async function proFeeAcknowledged(db: Db, userId: string): Promise<boolean> {
  return (await proFeeAckState(db, userId)).acknowledged;
}

/** What a pro is quoted now: the services rate, the function the price list and billing use. */
export function proFeeQuote(db: Db, userId: string) {
  return signupQuote(db, userId, { role: 'VENDOR', vendorType: 'SERVICE' });
}

/** Record a pro's fee tick: the words' version and the amount they saw must be the current ones, or nothing is written
 *  (WEEKLY_FEE_TERMS_CHANGED / WEEKLY_FEE_CHANGED), exactly as at partner sign-up. Idempotent per pro and amount. */
export async function recordProFeeAck(prisma: PrismaClient, input: { userId: string; ack: WeeklyFeeAck; surface: ConsentSurface; ip?: string | null }): Promise<void> {
  assertWeeklyFeeAck(true, input.ack);
  await publishLegalDocumentOnce(prisma, { documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION, renderedText: WEEKLY_FEE_ACK_TEXT_V1 });
  await prisma.$transaction(async (tx) => {
    const pro = await tx.serviceProvider.findUnique({ where: { userId: input.userId }, select: { id: true } });
    if (!pro) throw new AppError(404, 'NOT_FOUND', 'ServiceProvider not found');
    const quote = await proFeeQuote(tx, input.userId);
    assertSawQuote(input.ack, quote);
    // [REVIEW-G #2230 S3-1] Idempotent only for the SAME amount: a tick to a new amount (the rate changed since the
    // last tick) is a new consent and is written.
    if (tickIsFor(await latestProFeeTick(tx, input.userId), quote)) return;
    await recordConsent(tx, {
      subjectType: 'vendor_user', subjectId: input.userId, documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION,
      action: 'granted', surface: input.surface, ip: input.ip ?? null,
      evidence: { control: 'weekly_fee_checkbox', path: PRO_FEE_ACK_PATH, kind: 'PROVIDER', weeklyFee: { amount: quote.amount, currencyCode: quote.currencyCode, tier: quote.tier } },
    });
  });
}
