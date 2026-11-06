import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient, VehicleType } from '@prisma/client';
import { AppError } from '../../utils/errors';
import type { ConsentDocumentType } from '../legal/consent.service';
import { browserClientOf } from '../auth/browser-session';
import { moverRoleFor } from '../../config/vehicle-classes';
import { partnerRateFor, PricingConfigError, type PartnerTier, type SubscriptionTiers } from '../country/country-config.service';
import { DEPARTMENT_TRIAL_DAYS, TRIAL_DAYS } from '../subscription/trial-length';
import { OPERATOR } from '../legal/operator';

/**
 * [COORD ruling 22 Oct 2026 · row 628 · GUARDRAILS §1 + §7 standing rule 2] The weekly fee at partner sign-up.
 *
 * A store, rider or taxi driver sees the weekly fee BEFORE they submit sign-up: the amount (the server's quote,
 * GET /auth/pricing), what it covers, when it starts, how it is paid and the 14-day rule for a price rise — and
 * ticks "I understand the weekly fee" next to the partner agreement. Nobody pays at sign-up: the fee starts only
 * after approval (the billing flow then opens MMG's checkout page in the app).
 *
 * The current words below are served with the price list (`feeTerms`), so the phone and the website show exactly them,
 * and the tick is recorded in the consent ledger anchored to them (their own versioned document, like the 18+
 * tick) in the transaction that provisions the partner, with the amount the partner saw. That amount must be the
 * server's quote at that moment, or the sign-up is refused before anything is written (WEEKLY_FEE_CHANGED).
 *
 * The partner agreements already say all of this (shown before you start, MMG checkout in the app, no commission,
 * 14 days' notice): these words repeat them where a partner signs, and change no Terms or agreement text.
 *
 * Which clients must send the tick:
 *  - the website (a browser client): always — it ships with the tick;
 *  - any client that sends `weeklyFeeAck` (the phone app from the release after build 12, or an OTA to it).
 * Phone builds 9, 10, 11 and 12 send no such field and keep signing up partners; nothing is fabricated for them.
 * Once the oldest phone build in use ships the tick, requiring it from every client is a one-line change here.
 */
export const WEEKLY_FEE_ACK_TYPE: ConsentDocumentType = 'weekly_fee_acknowledgement';
/** The words served now, and the only version a NEW tick is taken on (assertWeeklyFeeAck). */
export const WEEKLY_FEE_ACK_VERSION = 'v4';
/**
 * [WEB-ONBOARDING · owner ruling 1 Nov 2026 (D3)] The versions whose tick still stands. v2 only adds the website as a
 * place to pay ("How you pay"); nothing about the fee changed, so a partner who ticked v1 is not asked again: a store
 * owner's store-fee tick (store-fee.ts latestStoreFeeTick) and a pro's fee tick (services/pro-fee.ts latestProFeeTick)
 * are read across these. The ledger keeps each row anchored to the words it was given to. v3 adds a way to pay
 * [OWNER 5 Nov 2026] and says the price rule exactly (a cut needs no 14-day wait; REVIEW-G18 S3-1); the fee itself and
 * how it is changed are the same, and the cut rule only ever works in the partner's favour, so a v1 or v2 tick stands.
 * [PAYAHEAD-4W · owner 6 Nov 2026] v4 lets the partner pay up to four weeks ahead (a choice, never required) and says how
 * a price change treats weeks paid ahead; the fee itself is the same and every change is in the partner's favour (more
 * ways to pay; a paid week keeps its price; a cut reaches weeks paid ahead), so a v1, v2 or v3 tick stands.
 */
export const WEEKLY_FEE_ACK_HONOURED_VERSIONS: readonly string[] = ['v1', 'v2', 'v3', 'v4'];

/**
 * The v1 words, in the order they were shown until 1 Nov 2026. Never edited: rows already in the ledger are anchored
 * to them (a version is a promise about specific words). "When it starts" says approval, not going live: a rider's or
 * driver's fee (trial or first week) is born at approval.
 */
export const WEEKLY_FEE_TERMS_V1 = {
  items: [
    { heading: 'What it covers', text: 'The Swift app and its tools for your work. Swift takes no commission: you keep 100% of your sales, fares, delivery fees and tips.' },
    { heading: 'When it starts', text: 'Nothing is paid at sign-up. The weekly fee starts only after Swift approves you, and after your free trial if you get one.' },
    { heading: 'How you pay', text: 'In the Swift app, on MMG’s checkout page, one week at a time. Paying by card is not offered yet.' },
    { heading: 'If the price changes', text: 'Swift tells you in the app at least 14 days before. A new price applies only from your first weekly fee due after that, never to a week you have already paid.' },
  ],
  tick: 'I understand the weekly fee.',
} as const;

/** The exact text the ledger anchors: each line as shown ("Heading: text"), then the tick. */
export const WEEKLY_FEE_ACK_TEXT_V1 = [
  ...WEEKLY_FEE_TERMS_V1.items.map((item) => `${item.heading}: ${item.text}`),
  WEEKLY_FEE_TERMS_V1.tick,
].join('\n');

/**
 * [WEB-ONBOARDING · owner rulings 1 Nov 2026 (D3, D1/F13)] The v2 words, two lines changed from v1:
 *  - "How you pay" names the website too (the weekly fee is paid on MMG's checkout page from swiftgy.com as well as
 *    from the app);
 *  - "When it starts" says the free trial plainly, and true on EVERY screen these words are ticked on [REVIEW-LIGHT2 M]:
 *    v1's "after your free trial if you get one" stays (the trial law can refuse one); how long a NEW partner's lasts
 *    (subscription/trial-length.ts TRIAL_DAYS, and DEPARTMENT_TRIAL_DAYS for a store at the department step, 10,000+
 *    items, when approved), counted from approval, and for a pro from the day the Pro Agreement says (the last of the
 *    fee's start for Providers, approval, acceptance and the fee tick: pros tick these same words); that a new branch
 *    (Add a branch ticks them too) has no trial of its own and shares its business's; and that each person gets one
 *    per kind of partner (the trial entitlement law: one per person, per role), none while an earlier subscription in
 *    their accounts is overdue, paused or ended (DEBT_REINSTATE_FIRST: PAST_DUE, SUSPENDED, CHURNED). A change to any
 *    of those numbers is a new version (the unit test pins them together).
 * "What it covers", "If the price changes" and the tick are v1's, word for word.
 */
export const WEEKLY_FEE_TERMS_V2 = {
  items: [
    { heading: 'What it covers', text: 'The Swift app and its tools for your work. Swift takes no commission: you keep 100% of your sales, fares, delivery fees and tips.' },
    { heading: 'When it starts', text: `Nothing is paid at sign-up. The weekly fee starts only after Swift approves you, and after your free trial if you get one. A new partner’s free trial lasts ${TRIAL_DAYS} days, or ${DEPARTMENT_TRIAL_DAYS} days for a store with 10,000 or more items when Swift approves it, counted from the day Swift approves you (for a service provider, from the day the Pro Agreement says). A new branch has no trial of its own: it shares its business’s. Each person gets one free trial for each kind of partner, and none while an earlier Swift subscription of theirs is overdue, paused or ended.` },
    { heading: 'How you pay', text: 'In the Swift app or on swiftgy.com, on MMG’s checkout page, one week at a time. Paying by card is not offered yet.' },
    { heading: 'If the price changes', text: 'Swift tells you in the app at least 14 days before. A new price applies only from your first weekly fee due after that, never to a week you have already paid.' },
  ],
  tick: 'I understand the weekly fee.',
} as const;

export const WEEKLY_FEE_ACK_TEXT_V2 = [
  ...WEEKLY_FEE_TERMS_V2.items.map((item) => `${item.heading}: ${item.text}`),
  WEEKLY_FEE_TERMS_V2.tick,
].join('\n');

/**
 * [OWNER 5 Nov 2026] The v3 words, two lines changed from v2:
 *  - "How you pay" adds paying the company directly, in person;
 *  - [REVIEW-G18 S3-1] "If the price changes" says the rule as the code applies it. A RISE waits at least 14 days
 *    after the in-app notice (fee-rise-notice.ts FEE_RISE_NOTICE_DAYS; price-book.ts PRICE_BOOK_NOTICE_DAYS; the admin
 *    door refuses a higher price sooner) and never touches a week already paid. A CUT needs no wait (owner 29 Oct): it
 *    applies from the next weekly fee not yet paid or charged (billing.service applyCardPriceCuts: "Issued charges and
 *    paid weeks keep their amount"; price-book.ts "A lower price needs no wait"), and the partner is told in the app
 *    (tellFeeDecrease). v1 and v2 promised 14 days before ANY change, which a cut never waited for. Same words as the
 *    agreements' fee-cut line. v3 was changed before any environment published it.
 * Everything else is v2's, word for word. Card-rail switch-on checklist: before card payment is offered, "How you pay"
 * must change again, and that is v4.
 */
const V3_CHANGED: Readonly<Record<string, string>> = {
  'How you pay': `In the Swift app or on swiftgy.com, on MMG’s checkout page, one week at a time. Or in person, directly to ${OPERATOR.name}, by cash, cheque or bank transfer: a cheque counts once it clears, a payment counts once Swift records it, and you get a receipt. Never give it to anyone else. Paying by card is not offered yet.`,
  'If the price changes': 'If the price goes up, Swift tells you in the app at least 14 days before, and the new price applies only from your first weekly fee due after that, never to a week you have already paid. If it goes down, the lower price applies from your next weekly fee not yet paid or charged, with a notice in the app.',
};
export const WEEKLY_FEE_TERMS_V3 = {
  items: WEEKLY_FEE_TERMS_V2.items.map((item) => {
    const text = V3_CHANGED[item.heading];
    return text === undefined ? item : { heading: item.heading, text };
  }),
  tick: WEEKLY_FEE_TERMS_V2.tick,
} as const;

export const WEEKLY_FEE_ACK_TEXT_V3 = [
  ...WEEKLY_FEE_TERMS_V3.items.map((item) => `${item.heading}: ${item.text}`),
  WEEKLY_FEE_TERMS_V3.tick,
].join('\n');

/**
 * [PAYAHEAD-4W · owner ruling 6 Nov 2026 "one month at a time", replaces owner #62] The v4 words, two lines changed from
 * v3 (v3 was live on production, so it is never edited):
 *  - "How you pay": up to four weeks ahead (billing/pay-ahead.ts PAY_AHEAD_MAX_WEEKS; the MMG checkout offers 1 to 4
 *    weeks), instead of "one week at a time";
 *  - "If the price changes": a cut reaches weeks already paid ahead (billing.service applyCardPriceCuts moves the rate;
 *    money paid ahead is charged at the rate of the week it pays) and the difference counts toward later fees. A rise
 *    never reaches a week already paid (applyHeldFeeRiseInTx; pay-ahead.ts riseFrom). Same words as the agreements.
 * Everything else is v3's, word for word.
 */
const V4_CHANGED: Readonly<Record<string, string>> = {
  'How you pay': `In the Swift app or on swiftgy.com, on MMG’s checkout page, for one week or up to four weeks ahead. Or in person, directly to ${OPERATOR.name}, by cash, cheque or bank transfer: a cheque counts once it clears, a payment counts once Swift records it, and you get a receipt. Never give it to anyone else. Paying by card is not offered yet.`,
  'If the price changes': 'If the price goes up, Swift tells you in the app at least 14 days before, and the new price applies only from your first weekly fee due after that, never to a week you have already paid. If it goes down, the lower price applies from your next weekly fee not yet charged, even one you have already paid for, with a notice in the app; what you paid above it counts toward your later weekly fees.',
};
export const WEEKLY_FEE_TERMS_V4 = {
  items: WEEKLY_FEE_TERMS_V3.items.map((item) => {
    const text = V4_CHANGED[item.heading];
    return text === undefined ? item : { heading: item.heading, text };
  }),
  tick: WEEKLY_FEE_TERMS_V3.tick,
} as const;

export const WEEKLY_FEE_ACK_TEXT_V4 = [
  ...WEEKLY_FEE_TERMS_V4.items.map((item) => `${item.heading}: ${item.text}`),
  WEEKLY_FEE_TERMS_V4.tick,
].join('\n');

/** The words of WEEKLY_FEE_ACK_VERSION: what is served, and what a new tick is published and anchored to. */
export const WEEKLY_FEE_TERMS = WEEKLY_FEE_TERMS_V4;
export const WEEKLY_FEE_ACK_TEXT = WEEKLY_FEE_ACK_TEXT_V4;

export interface WeeklyFeeTerms { version: string; items: { heading: string; text: string }[]; tick: string }

/** What GET /auth/pricing serves beside the amounts. */
export function weeklyFeeTerms(): WeeklyFeeTerms {
  return { version: WEEKLY_FEE_ACK_VERSION, items: WEEKLY_FEE_TERMS.items.map((item) => ({ ...item })), tick: WEEKLY_FEE_TERMS.tick };
}

export const WEEKLY_FEE_ACK_REQUIRED = 'WEEKLY_FEE_ACK_REQUIRED';
export const WEEKLY_FEE_TERMS_CHANGED = 'WEEKLY_FEE_TERMS_CHANGED';
export const WEEKLY_FEE_CHANGED = 'WEEKLY_FEE_CHANGED';

/** The tick as a client sends it: the words' version and the fee it showed. */
export interface WeeklyFeeAck { version: string; amount: number; currencyCode: string }

/** True when this sign-up must carry the tick (see the rule above). */
export function weeklyFeeAckRequired(request: Pick<FastifyRequest, 'headers'>, body: { weeklyFeeAck?: unknown }): boolean {
  return body.weeklyFeeAck !== undefined || browserClientOf(request) !== null;
}

/** Refused before anything is written: a required tick that is missing, or one given to other words. */
export function assertWeeklyFeeAck(required: boolean, ack: WeeklyFeeAck | undefined): void {
  if (!ack) {
    if (required) throw new AppError(400, WEEKLY_FEE_ACK_REQUIRED, 'Read the weekly fee and tick “I understand the weekly fee” to continue. If you can’t see it, reload the page.');
    return;
  }
  if (ack.version !== WEEKLY_FEE_ACK_VERSION) {
    throw new AppError(409, WEEKLY_FEE_TERMS_CHANGED, 'The weekly fee terms have changed. Read them again and tick “I understand the weekly fee” to continue.', { version: WEEKLY_FEE_ACK_VERSION });
  }
}

/** Who sign-up prices: a mover by the vehicle, a new store by its type (no catalogue yet: the first step). */
export type FeeSubject = { role: 'MOVER'; vehicleType: VehicleType } | { role: 'VENDOR'; vendorType: string };

export interface SignupQuote { amount: number; currencyCode: string; tier: PartnerTier }

/** The weekly fee this account is quoted right now — the function the price list and billing use. */
export async function signupQuote(db: PrismaClient | Prisma.TransactionClient, userId: string, subject: FeeSubject): Promise<SignupQuote> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { countryCode: true } });
  const config = await db.countryConfig.findUnique({ where: { code: user.countryCode }, select: { currencyCode: true, subscriptionTiers: true } });
  if (!config) throw new PricingConfigError('countryConfig');
  const tiers = config.subscriptionTiers as unknown as SubscriptionTiers;
  const { rate, tier } = subject.role === 'VENDOR'
    ? partnerRateFor(tiers, { kind: 'VENDOR', isService: subject.vendorType === 'SERVICE', activeListings: 0 })
    : partnerRateFor(tiers, { kind: moverRoleFor(subject.vehicleType), vehicleType: subject.vehicleType });
  return { amount: rate, currencyCode: config.currencyCode, tier };
}

/** The fee the partner saw must be the quote now, or nothing is written and they read it again. */
export function assertSawQuote(ack: WeeklyFeeAck, quote: SignupQuote): void {
  if (ack.amount === quote.amount && ack.currencyCode === quote.currencyCode) return;
  throw new AppError(
    409,
    WEEKLY_FEE_CHANGED,
    `The weekly fee for this choice is ${quote.currencyCode} ${quote.amount.toLocaleString('en-US')} a week. Check it and tick “I understand the weekly fee” again.`,
    { amount: quote.amount, currencyCode: quote.currencyCode },
  );
}
