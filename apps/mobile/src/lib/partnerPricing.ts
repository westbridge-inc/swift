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

/** A billable weekly fee: a finite amount above zero. */
function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

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
