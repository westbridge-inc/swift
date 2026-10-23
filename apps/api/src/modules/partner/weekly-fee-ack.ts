import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient, VehicleType } from '@prisma/client';
import { AppError } from '../../utils/errors';
import type { ConsentDocumentType } from '../legal/consent.service';
import { browserClientOf } from '../auth/browser-session';
import { moverRoleFor } from '../../config/vehicle-classes';
import { partnerRateFor, PricingConfigError, type PartnerTier, type SubscriptionTiers } from '../country/country-config.service';

/**
 * [COORD ruling 22 Oct 2026 · row 628 · GUARDRAILS §1 + §7 standing rule 2] The weekly fee at partner sign-up.
 *
 * A store, rider or taxi driver sees the weekly fee BEFORE they submit sign-up: the amount (the server's quote,
 * GET /auth/pricing), what it covers, when it starts, how it is paid and the 14-day rule for price changes — and
 * ticks "I understand the weekly fee" next to the partner agreement. Nobody pays at sign-up: the fee starts only
 * after approval (the billing flow then opens MMG's checkout page in the app).
 *
 * The words below are served with the price list (`feeTerms`), so the phone and the website show exactly them,
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
export const WEEKLY_FEE_ACK_VERSION = 'v1';

/**
 * The v1 words, in the order they are shown. A change is a new version — a version is a promise about specific words.
 * "When it starts" says approval, not going live: a rider's or driver's fee (trial or first week) is born at approval.
 * Card-rail switch-on checklist: before card payment is offered, "How you pay" must change, and that is v2.
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

export interface WeeklyFeeTerms { version: string; items: { heading: string; text: string }[]; tick: string }

/** What GET /auth/pricing serves beside the amounts. */
export function weeklyFeeTerms(): WeeklyFeeTerms {
  return { version: WEEKLY_FEE_ACK_VERSION, items: WEEKLY_FEE_TERMS_V1.items.map((item) => ({ ...item })), tick: WEEKLY_FEE_TERMS_V1.tick };
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
