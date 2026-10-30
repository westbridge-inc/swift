import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { formatMoney } from '../../utils/currency-amount';
import { PricingConfigError, partnerRateFor, type PartnerTier, type SubscriptionTiers } from '../country/country-config.service';
import { publishLegalDocumentOnce, recordConsent, type ConsentSurface } from '../legal/consent.service';
import { assertSawQuote, assertWeeklyFeeAck, WEEKLY_FEE_ACK_TEXT_V1, WEEKLY_FEE_ACK_TYPE, WEEKLY_FEE_ACK_VERSION, type WeeklyFeeAck } from './weekly-fee-ack';

// ---------------------------------------------------------------------------
// [RETIER PR-A · owner 30 Oct 2026 15:54Z "okay" · GUARDRAILS §1 + §7 standing rule 2] A NEW store's weekly fee is
// priced from its REAL catalogue when the fee is born, and the store sees and agrees to that exact amount first.
//
// A store signs up before it has a catalogue, so the sign-up quote is the first catalogue step (weekly-fee-ack.ts
// signupQuote). It builds its catalogue while it waits for Swift, and its weekly fee is born when Swift approves it
// (subscription.service vendorActivation). That fee is the step its OWN catalogue reaches then — counted as its free
// trial is counted (trial-length.ts): every listing available now, or made unavailable or edited in the last 7 days, so
// hiding listings just before approval does not count them out — and a chain branch is charged the lower of its
// owner's deal and that step (subscription-fee.ts weeklyFeeFor). A Services business has no catalogue: the services
// rate, as before.
//
// When the fee born that way is ABOVE the first step (the amount every store was shown at sign-up), the store goes
// live only after its owner has read the weekly fee and ticked "I understand the weekly fee" for THAT store at exactly
// that amount and currency (the same versioned words as sign-up, a row in the consent ledger anchored to them, with
// the store, the amount, the step and the item count it was quoted from). The activation projection asks once per
// store per amount (a notice), the go-live checklist names the step, the console refuses to activate without it, and
// the birth itself re-checks the tick under the activation locks (STORE_FEE_TICK_REQUIRED): nothing is born at an
// amount the owner did not tick. A store at or under the first step is born exactly as before (old phone builds,
// which never show this tick, keep signing up and going live). Existing fees are never moved by this file.
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 86_400_000;

/** The path a store's own fee tick is recorded under (sign-up's is 'partner/become', a branch's 'vendor/stores'). */
export const STORE_FEE_ACK_PATH = 'vendor/store-weekly-fee-ack';
/** The notice that asks the owner for the tick (its tap opens the waiting store's weekly-fee card). */
export const STORE_FEE_NOTICE_KIND = 'vendor_needs_weekly_fee_tick';
export const STORE_FEE_TICK_REQUIRED = 'STORE_FEE_TICK_REQUIRED';
export const STORE_FEE_ALREADY_SET = 'STORE_FEE_ALREADY_SET';

/** The store's catalogue as its fee and trial are priced from it: available now, or made unavailable or edited in
 *  the last 7 days (the re-tier's lower-tier count, billing.service recalculateVendorTiers). */
export function storeCatalogueCount(db: Db, vendorId: string, now = new Date()): Promise<number> {
  return db.item.count({ where: { vendorId, OR: [{ isAvailable: true }, { updatedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } }] } });
}

export interface StoreFeeQuote {
  vendorId: string;
  /** The store's owner: who ticks. */
  ownerUserId: string;
  /** What the store would be charged a week if its fee were born now: the lower of its chain deal and its step. */
  amount: number;
  currencyCode: string;
  /** The step its catalogue reaches (or 'service'). */
  tier: PartnerTier;
  /** The step's own rate (the subscription's weeklyRate). */
  cardRate: number;
  /** The listings counted (null for a Services business: no catalogue). */
  items: number | null;
  /** The owner's chain deal in this currency, or null. */
  dealRate: number | null;
  /** The first step for this store's type: what every sign-up was quoted. */
  signupAmount: number;
  /** True when the amount is above the sign-up quote: the owner ticks this exact amount before the fee is born. */
  tickRequired: boolean;
}

/** The charged amount for a step and a deal: the lower of the two (weeklyFeeFor's rule). */
export function chargedFor(cardRate: number, dealRate: number | null): number {
  return dealRate === null ? cardRate : Math.min(cardRate, dealRate);
}

/** Is a fee tick needed for this amount, against the first step every sign-up was quoted? */
export function storeFeeTickNeeded(amount: number, signupAmount: number): boolean {
  return amount > signupAmount;
}

/**
 * The weekly fee this store would be born on NOW, and whether its owner must tick it first. Reads only; `db` may be
 * the activation transaction (the birth re-reads the chain deal under its own lock and re-checks: assertStoreFeeTicked).
 */
export async function storeFeeQuote(db: Db, vendorId: string, now = new Date()): Promise<StoreFeeQuote> {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { vendorType: true, owner: { select: { userId: true, dealWeeklyRate: true, dealCurrencyCode: true, user: { select: { countryCode: true } } } } },
  });
  if (!vendor) throw new AppError(404, 'VENDOR_NOT_FOUND', 'Store not found');
  const config = await db.countryConfig.findUnique({ where: { code: vendor.owner.user.countryCode }, select: { currencyCode: true, subscriptionTiers: true } });
  if (!config) throw new PricingConfigError('countryConfig');
  const tiers = config.subscriptionTiers as unknown as SubscriptionTiers;
  const isService = vendor.vendorType === 'SERVICE';
  const signup = partnerRateFor(tiers, { kind: 'VENDOR', isService, activeListings: 0 });
  const items = isService ? null : await storeCatalogueCount(db, vendorId, now);
  const step = isService ? signup : partnerRateFor(tiers, { kind: 'VENDOR', isService, activeListings: items ?? 0 });
  // The owner's chain deal, as the birth reads it (subscription.service chainDealFor): same currency, above zero.
  const deal = vendor.owner.dealWeeklyRate;
  const dealRate = deal !== null && deal !== undefined && vendor.owner.dealCurrencyCode === config.currencyCode && Number(deal) > 0 ? Number(deal) : null;
  const amount = chargedFor(step.rate, dealRate);
  return {
    vendorId, ownerUserId: vendor.owner.userId, amount, currencyCode: config.currencyCode, tier: step.tier, cardRate: step.rate, items, dealRate,
    signupAmount: signup.rate, tickRequired: storeFeeTickNeeded(amount, signup.rate),
  };
}

/** A store fee tick: the amount and currency the words were ticked to. */
export interface StoreFeeTick { amount: number; currencyCode: string }

/** The owner's LATEST store fee tick for this store (current words), or null when there is none or it was withdrawn. */
export async function latestStoreFeeTick(db: Db, ownerUserId: string, vendorId: string): Promise<StoreFeeTick | null> {
  const tick = await db.consentRecord.findFirst({
    where: {
      subjectId: ownerUserId, documentType: WEEKLY_FEE_ACK_TYPE, documentVersion: WEEKLY_FEE_ACK_VERSION,
      AND: [{ evidence: { path: ['path'], equals: STORE_FEE_ACK_PATH } }, { evidence: { path: ['vendorId'], equals: vendorId } }],
    },
    orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
    select: { action: true, evidence: true },
  });
  if (!tick || tick.action === 'withdrawn') return null;
  const fee = (tick.evidence as { weeklyFee?: { amount?: unknown; currencyCode?: unknown } } | null)?.weeklyFee;
  return typeof fee?.amount === 'number' && typeof fee.currencyCode === 'string' ? { amount: fee.amount, currencyCode: fee.currencyCode } : null;
}

/** Was this tick given to exactly this fee (amount AND currency)? */
export function storeTickIsFor(tick: StoreFeeTick | null, fee: StoreFeeTick): boolean {
  return !!tick && tick.amount === fee.amount && tick.currencyCode === fee.currencyCode;
}

export interface StoreFeeStanding {
  /** The store has no weekly fee yet and the one it would be born on needs the owner's tick. */
  required: boolean;
  /** The owner ticked exactly that amount for this store. */
  ticked: boolean;
  /** The quote (null once the store has a fee: its price changes follow the 14-day notice, never this tick). */
  quote: StoreFeeQuote | null;
}

/** Does this store still need its owner's fee tick to go live? A store that already has a fee never does. */
export async function storeFeeStanding(db: Db, vendorId: string, now = new Date()): Promise<StoreFeeStanding> {
  const existing = await db.subscription.findUnique({ where: { vendorId }, select: { id: true } });
  if (existing) return { required: false, ticked: false, quote: null };
  const quote = await storeFeeQuote(db, vendorId, now);
  if (!quote.tickRequired) return { required: false, ticked: false, quote };
  return { required: true, ticked: storeTickIsFor(await latestStoreFeeTick(db, quote.ownerUserId, vendorId), quote), quote };
}

/**
 * The birth's own re-check, under the activation locks (subscription.service createRow): the amount about to be
 * charged, if above the first step, must be exactly the amount the owner ticked for this store. Otherwise nothing is
 * written (409 STORE_FEE_TICK_REQUIRED).
 */
export async function assertStoreFeeTicked(
  db: Db,
  p: { vendorId: string; ownerUserId: string; amount: number; currencyCode: string; signupAmount: number },
): Promise<void> {
  if (!storeFeeTickNeeded(p.amount, p.signupAmount)) return;
  if (storeTickIsFor(await latestStoreFeeTick(db, p.ownerUserId, p.vendorId), p)) return;
  throw new AppError(
    409,
    STORE_FEE_TICK_REQUIRED,
    `This store's weekly fee is ${formatMoney(p.amount, p.currencyCode, { whole: true })} a week. Its owner reads it and ticks “I understand the weekly fee” for this store before it goes live.`,
    { vendorId: p.vendorId, amount: p.amount, currencyCode: p.currencyCode },
  );
}

/** The step in the owner's words. */
export function storeTierWords(tier: PartnerTier): string {
  switch (tier) {
    case 'department': return 'department store';
    case 'large': return 'large catalogue';
    case 'service': return 'service business';
    default: return 'business';
  }
}

/** Why this amount, in one sentence (the quote's own numbers). */
export function storeFeeWhy(quote: Pick<StoreFeeQuote, 'items' | 'tier' | 'cardRate' | 'dealRate' | 'amount' | 'currencyCode'>): string {
  const money = (n: number) => formatMoney(n, quote.currencyCode, { whole: true });
  const size = quote.items === null ? '' : `It has ${quote.items.toLocaleString('en-US')} items for sale, so it is on the ${storeTierWords(quote.tier)} rate of ${money(quote.cardRate)} a week.`;
  const deal = quote.dealRate !== null && quote.amount < quote.cardRate ? ` Your Swift chain deal brings it to ${money(quote.amount)}.` : '';
  return `${size}${deal}`.trim();
}

/** The one notice that asks the owner for the tick (once per store per amount). */
export function storeFeeNotice(storeName: string, quote: Pick<StoreFeeQuote, 'items' | 'tier' | 'cardRate' | 'dealRate' | 'amount' | 'currencyCode'>): { title: string; body: string } {
  return {
    title: 'Check your weekly fee to go live',
    body: `${storeName}'s weekly fee will be ${formatMoney(quote.amount, quote.currencyCode, { whole: true })} a week. ${storeFeeWhy(quote)} `
      + 'Read it and tick “I understand the weekly fee” for this store in Swift, and it goes live. Nothing is charged before you do.',
  };
}

export const storeFeeNoticeDedupeKey = (vendorId: string, fee: StoreFeeTick) => `${STORE_FEE_NOTICE_KIND}:${vendorId}:${fee.amount}:${fee.currencyCode}`;

/**
 * Record the owner's tick for one store: the words' version and the amount they saw must be the current ones (the
 * quote now, under the store's row lock), or nothing is written (WEEKLY_FEE_TERMS_CHANGED / WEEKLY_FEE_CHANGED). A
 * store that already has a weekly fee is refused (its price changes follow the 14-day notice). The same amount
 * again writes nothing. Returns whether a row was written.
 */
export async function recordStoreFeeAck(
  prisma: PrismaClient,
  input: { userId: string; vendorId: string; ack: WeeklyFeeAck; surface: ConsentSurface; ip?: string | null },
): Promise<{ recorded: boolean; quote: StoreFeeQuote }> {
  assertWeeklyFeeAck(true, input.ack);
  await publishLegalDocumentOnce(prisma, { documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION, renderedText: WEEKLY_FEE_ACK_TEXT_V1 });
  return prisma.$transaction(async (tx) => {
    // One tick per store at a time: the store row is the lock, and the quote is read again under it.
    await tx.$queryRaw`SELECT "id" FROM "vendors" WHERE "id" = ${input.vendorId} FOR UPDATE /* store-weekly-fee-tick */`;
    if (await tx.subscription.findUnique({ where: { vendorId: input.vendorId }, select: { id: true } })) {
      throw new AppError(409, STORE_FEE_ALREADY_SET, 'This store already has its weekly fee. A change to it is told in the app at least 14 days ahead.');
    }
    const quote = await storeFeeQuote(tx, input.vendorId);
    if (quote.ownerUserId !== input.userId) throw new AppError(403, 'FORBIDDEN', 'Only the store’s owner ticks its weekly fee.');
    assertSawQuote(input.ack, { amount: quote.amount, currencyCode: quote.currencyCode, tier: quote.tier });
    if (storeTickIsFor(await latestStoreFeeTick(tx, input.userId, input.vendorId), quote)) return { recorded: false, quote };
    await recordConsent(tx, {
      subjectType: 'vendor_user', subjectId: input.userId, documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION,
      action: 'granted', surface: input.surface, ip: input.ip ?? null,
      evidence: {
        control: 'weekly_fee_checkbox', path: STORE_FEE_ACK_PATH, kind: 'STORE', vendorId: input.vendorId,
        weeklyFee: { amount: quote.amount, currencyCode: quote.currencyCode, tier: quote.tier, cardRate: quote.cardRate, items: quote.items, dealRate: quote.dealRate },
      },
    });
    return { recorded: true, quote };
  });
}
