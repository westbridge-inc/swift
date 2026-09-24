/**
 * The partner price list as the API serves it (GET /auth/pricing).
 *
 * The app never prices a partner itself. Every number here was resolved on the
 * server by the same function signup and the weekly re-tier bill through, so
 * what a partner is quoted is what they are billed. This module only LOOKS UP
 * the quote for one vehicle or one business, and answers null — never a zero
 * and never a guess — when the list holds no valid quote for it. The legacy
 * `weekly` numbers are deliberately never read: they conflate several kinds of
 * partner into one figure for apps that predate the typed list.
 */

export type MoverRole = 'RIDER' | 'DRIVER';
export type MoverFeeBand = 'STANDARD' | 'HEAVY';
/** Which rate a mover pays: a taxi Driver, or a Rider on a standard or heavy vehicle. */
export type MoverTier = 'courier' | 'courierHeavy' | 'taxi';
export type CatalogueTier = 'small' | 'large' | 'department';
export type PartnerVendorType = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

/** One vehicle a mover can register, priced for the role it provisions. */
export interface MoverQuote {
  vehicleType: string;
  label: string;
  role: MoverRole;
  band: MoverFeeBand;
  tier: MoverTier;
  rate: number;
  /** [Launch vehicle list] False for a vehicle Swift does not take on yet (lib/vehicleOffer). Absent from older servers. */
  offered?: boolean;
}

/** One catalogue step: from `minItems` active items, `rate` per week. */
export interface CatalogueBand {
  minItems: number;
  tier: CatalogueTier;
  rate: number;
}

export interface PartnerPricing {
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  isActive: boolean;
  trialDays: number;
  /** Every vehicle, in picker order. Absent from an API that predates it. */
  movers?: MoverQuote[];
  /** Services are flat; catalogue businesses step up by active items. */
  vendors?: { service: number; catalogue: CatalogueBand[] };
  franchise: { minLocations: number; discountPct: number } | null;
  /** @deprecated Conflated numbers kept for older apps — never read them. */
  weekly?: Record<string, number | null>;
}

/** What a business is quoted: its tier today and the steps it can move along. */
export interface VendorQuote {
  tier: CatalogueTier | 'service';
  rate: number;
  /** The catalogue steps, from 0 items up; empty for a service. */
  ladder: CatalogueBand[];
}

const MOVER_TIERS: readonly string[] = ['courier', 'courierHeavy', 'taxi'];

/** A billable weekly fee: a whole number of currency units above zero. The
 *  server refuses anything else, and so does this: `moneyIn` rounds to whole
 *  units, so a fraction would be shown as a different number than the one
 *  held — or, for a fraction below half a dollar, as $0. */
function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * How long a fetched quote may stand for "the price today" on a signup
 * screen. The preview surfaces may read an hour-old list; a partner about to
 * agree to a weekly fee may not — the signup hook refetches on mount and every
 * minute it stays open, and this bounds what it may rely on when timers were
 * suspended in the background.
 */
export const QUOTE_MAX_AGE_MS = 5 * 60 * 1000;

export type QuoteGate<Q> = { ok: true; quote: Q } | { ok: false; why: 'loading' | 'error' | 'missing' | 'stale' };

/**
 * Whether a partner may commit to a fee right now: only with a quote that was
 * fetched successfully, is for the vehicle or business type they picked, and
 * is recent. Loading, a failed fetch (even with an older answer still in
 * hand — an unconfirmed price is not the price), no quote for the selection,
 * or a quote older than QUOTE_MAX_AGE_MS each refuse: the submit control is
 * disabled and says why. The quote is `pick`ed from the same data the price
 * card renders, so the gate and the card cannot disagree.
 */
export function quoteGate<Q>(
  query: { data?: PartnerPricing | null; isPending?: boolean; isError?: boolean; dataUpdatedAt?: number },
  pick: (pricing: PartnerPricing | null | undefined) => Q | null,
  now: number = Date.now(),
): QuoteGate<Q> {
  if (query.isError) return { ok: false, why: 'error' };
  if (query.isPending || query.data == null) return { ok: false, why: 'loading' };
  const quote = pick(query.data);
  if (!quote) return { ok: false, why: 'missing' };
  if (typeof query.dataUpdatedAt !== 'number' || now - query.dataUpdatedAt > QUOTE_MAX_AGE_MS) return { ok: false, why: 'stale' };
  return { ok: true, quote };
}

/** What the disabled submit control says for each refusal — the ask, never a
 *  number ([#947's grammar]: disabled says the ask). */
export const QUOTE_GATE_COPY: Record<Extract<QuoteGate<unknown>, { ok: false }>['why'], string> = {
  loading: 'Loading your weekly fee…',
  error: 'Couldn’t load your weekly fee — check your connection',
  missing: 'No weekly fee is set for this choice yet',
  stale: 'Refreshing your weekly fee…',
};

/** The quote for the vehicle a mover registers, or null when there is none. */
export function moverQuote(pricing: PartnerPricing | null | undefined, vehicleType: string | null | undefined): MoverQuote | null {
  if (!pricing || !vehicleType || !Array.isArray(pricing.movers)) return null;
  const quote = pricing.movers.find((q) => q?.vehicleType === vehicleType);
  if (!quote || !isRate(quote.rate) || !MOVER_TIERS.includes(quote.tier)) return null;
  return quote.role === 'RIDER' || quote.role === 'DRIVER' ? quote : null;
}

/** A usable catalogue ladder: starts at 0 items, whole-number steps strictly
 *  rising, every step a billable rate. Anything else is no ladder at all. */
function validLadder(catalogue: unknown): CatalogueBand[] | null {
  if (!Array.isArray(catalogue) || catalogue.length === 0) return null;
  let previous = -1;
  for (const band of catalogue as CatalogueBand[]) {
    if (!band || !isRate(band.rate) || !Number.isInteger(band.minItems) || band.minItems <= previous) return null;
    previous = band.minItems;
  }
  return (catalogue as CatalogueBand[])[0]!.minItems === 0 ? (catalogue as CatalogueBand[]) : null;
}

/**
 * The quote for a business. A service is flat; a restaurant, grocery or shop is
 * priced by its active items with the biller's own boundaries — the step count
 * itself qualifies ("1,000+" is >= 1,000). A new store has no catalogue yet, so
 * it is quoted the first step.
 */
export function vendorQuote(
  pricing: PartnerPricing | null | undefined,
  vendorType: PartnerVendorType,
  activeItems = 0,
): VendorQuote | null {
  const vendors = pricing?.vendors;
  if (!vendors) return null;
  if (vendorType === 'SERVICE') return isRate(vendors.service) ? { tier: 'service', rate: vendors.service, ladder: [] } : null;
  const ladder = validLadder(vendors.catalogue);
  if (!ladder) return null;
  let band = ladder[0]!;
  for (const step of ladder) if (activeItems >= step.minItems) band = step;
  return { tier: band.tier, rate: band.rate, ladder };
}
