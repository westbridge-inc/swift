import type { PrismaClient, CountryConfig, VehicleType, Prisma } from '@prisma/client';
import { registryChecklist, UNREGISTERED_LIST_SUFFIX, UNREGISTERED_TIER } from '../verification/doc-registry';
import { COMPLETE_CARD, DEFAULT_DOCUMENT_CHECKLISTS } from '../ops/platform-config';
import { AppError, NotFoundError } from '../../utils/errors';
import type { DeliveryRates } from '../../utils/markup';
import { readDeliveryRates } from './pricing-config';
import { docProfilesFor, feeBandFor, type MoverRole } from '../../config/vehicle-classes';

type Db = PrismaClient | Prisma.TransactionClient;

/** Weekly subscription tiers in local currency. */
export interface SubscriptionTiers {
  /**
   * `'complete'` declares the full partner card: every rate, both catalogue
   * boundaries and the franchise rule are present and valid, and NO fallback
   * below applies — a missing key refuses the whole market rather than
   * quietly pricing it as a different card. Absent in a legacy market, which
   * keeps the documented fallbacks exactly as before.
   */
  card?: typeof COMPLETE_CARD;
  /** STANDARD fee band — a delivery/courier Rider on a bicycle or motorbike
   *  (and, where `taxiDriver` is absent, a Driver on a car or wagon car). */
  mover: number;
  /** HEAVY fee band — heavy delivery on a canter or box truck (and, where
   *  `taxiDriver` is absent, a Driver on a bus). A LEGACY market may leave it
   *  unset, which resolves back to `mover`. */
  moverHeavy?: number;
  /** Every taxi Driver, whatever the vehicle. A LEGACY market may leave it
   *  unset, where a Driver pays the band rate like everyone else. */
  taxiDriver?: number;
  /** Services with no catalogue — a plumber, electrician or barber. A LEGACY
   *  market may leave it unset, falling back to `smallVendor`. */
  serviceVendor?: number;
  /** Standard catalogue, below `largeCatalogueThreshold` items. */
  smallVendor: number;
  /** At or above `largeCatalogueThreshold` items. */
  largeVendor: number;
  /** Department-store scale — at or above `departmentCatalogueThreshold`. A
   *  LEGACY market may leave it unset, which removes that step. */
  departmentVendor?: number;
  largeCatalogueThreshold?: number;
  departmentCatalogueThreshold?: number;
  /** Franchise: from `franchiseMinLocations` stores under one owner, every
   *  location takes `franchiseDiscountPct` off ITS OWN rate. Both keys or
   *  neither — one alone is a broken rule, never "no rule". */
  franchiseMinLocations?: number;
  franchiseDiscountPct?: number;
  [tier: string]: number | string | undefined;
}

export const DEFAULT_LARGE_CATALOGUE_THRESHOLD = 1000;
export const DEFAULT_DEPARTMENT_CATALOGUE_THRESHOLD = 10000;

/** What a vendor's weekly rate is decided from. */
export interface VendorRateBasis {
  /** SERVICE vendors have no catalogue to count. */
  isService: boolean;
  /** Active listings on this store. */
  activeListings: number;
  /** How many stores this owner holds — the franchise basis. */
  ownedStores: number;
}

/** Which tier a vendor's rate is built from, before any franchise discount. */
export type VendorRateReason = 'department' | 'large' | 'service' | 'small';

/** Which tier a mover's rate is built from: a taxi Driver, or a Rider on a
 *  standard or heavy vehicle. */
export type MoverTier = 'taxi' | 'courier' | 'courierHeavy';

/** Every tier a partner's weekly fee can be built from. */
export type PartnerTier = MoverTier | VendorRateReason;

/** Who is being priced. The role decides first; the vehicle or the catalogue
 *  decides within it. There is deliberately no sales figure anywhere in here:
 *  the fee is flat and partners keep every sale, fare and tip. */
export type PartnerSubject =
  | { kind: MoverRole; vehicleType: VehicleType }
  | ({ kind: 'VENDOR' } & VendorRateBasis);

export interface PartnerRate {
  /** What this partner owes per week, any franchise discount already applied. */
  rate: number;
  /** The tier the rate was built from. */
  tier: PartnerTier;
  /** Whether the franchise discount was applied (vendors only). */
  franchised: boolean;
}

/**
 * A market whose tier config cannot price a partner — a missing, zero,
 * negative, fractional or non-numeric rate, a nonsensical catalogue boundary,
 * half a franchise rule, or a discount that leaves nothing to pay. Signup
 * refuses, activation refuses, the re-tier holds the current rate, and the
 * public list refuses to quote: an unknown price is an error, never a free
 * subscription.
 */
export class PricingConfigError extends AppError {
  constructor(key: string) {
    super(500, 'PRICING_CONFIG_INVALID', `Weekly-fee config "${key}" is missing or is not a whole positive amount`, { key });
    this.name = 'PricingConfigError';
  }
}

/**
 * A configured rate: a whole number of currency units above zero, or the
 * config is refused. Whole because a weekly fee is a number a partner reads
 * off an invoice and a client renders through a whole-unit formatter, and
 * because the columns that hold it are Decimal(10,2) and Decimal(12,2): a
 * 0.001 would be quoted as one thing, rendered as $0 and persisted as 0.00.
 */
function requiredRate(tiers: SubscriptionTiers, key: string): number {
  const value: unknown = tiers[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new PricingConfigError(key);
  return value;
}

/** A rate a LEGACY market may leave unset ("not priced apart"); the complete
 *  card may not. Present must be valid either way. */
function optionalRate(tiers: SubscriptionTiers, key: string, complete: boolean): number | undefined {
  if (tiers[key] == null) {
    if (complete) throw new PricingConfigError(key);
    return undefined;
  }
  return requiredRate(tiers, key);
}

/** A catalogue boundary is a whole number of items above zero. A LEGACY market
 *  may leave it to the default; the complete card states it. */
function catalogueFloor(tiers: SubscriptionTiers, key: string, fallback: number, complete: boolean): number {
  const value: unknown = tiers[key];
  if (value == null) {
    if (complete) throw new PricingConfigError(key);
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new PricingConfigError(key);
  return value;
}

/**
 * Whether the market declares the complete card (`card: 'complete'`). A
 * declaration this code does not know is a broken market, not a legacy one:
 * the only way to be priced with fallbacks is to declare nothing at all.
 */
export function isCompleteCard(tiers: SubscriptionTiers): boolean {
  const card: unknown = tiers.card;
  if (card == null) return false;
  if (card !== COMPLETE_CARD) throw new PricingConfigError('card');
  return true;
}

/** The franchise rule a market bills: from `minLocations` stores under one
 *  owner, every location takes `discountPct` off its OWN rate. */
export interface FranchiseRule {
  minLocations: number;
  discountPct: number;
}

/**
 * The market's franchise rule, validated — the same answer for the biller and
 * the public price list, so the list never quotes a rule billing would refuse.
 * Null when the market has none: BOTH keys absent, or an explicit zero
 * discount. One key alone is half a rule — a chain silently losing its
 * discount — and is refused in every market. A location count that is not a
 * whole number of stores, or a discount that is negative, not a number, or
 * leaves nothing to pay, is a broken market.
 */
export function franchiseRuleFor(tiers: SubscriptionTiers): FranchiseRule | null {
  const minLocations: unknown = tiers.franchiseMinLocations;
  const discountPct: unknown = tiers.franchiseDiscountPct;
  if (minLocations == null && discountPct == null) return null;
  if (minLocations == null) throw new PricingConfigError('franchiseMinLocations');
  if (discountPct == null) throw new PricingConfigError('franchiseDiscountPct');
  if (typeof minLocations !== 'number' || !Number.isInteger(minLocations) || minLocations < 1) {
    throw new PricingConfigError('franchiseMinLocations');
  }
  if (typeof discountPct !== 'number' || !Number.isFinite(discountPct) || discountPct < 0 || discountPct >= 100) {
    throw new PricingConfigError('franchiseDiscountPct');
  }
  return discountPct > 0 ? { minLocations, discountPct } : null;
}

/** One catalogue step: from `minItems` active items, `rate` per week. */
export interface CatalogueStep {
  minItems: number;
  tier: Exclude<VendorRateReason, 'service'>;
  rate: number;
}

/**
 * The catalogue ladder a market bills — small from 0 items, large from its
 * floor, department from its floor where the market prices one — validated
 * as ONE shape, so the biller and the public list read the same steps. A
 * department step at or below the large one would leave the large tier
 * unreachable and the ladder out of order.
 */
export function catalogueStepsFor(tiers: SubscriptionTiers): CatalogueStep[] {
  const complete = isCompleteCard(tiers);
  const largeFloor = catalogueFloor(tiers, 'largeCatalogueThreshold', DEFAULT_LARGE_CATALOGUE_THRESHOLD, complete);
  const department = optionalRate(tiers, 'departmentVendor', complete);
  const deptFloor = catalogueFloor(tiers, 'departmentCatalogueThreshold', DEFAULT_DEPARTMENT_CATALOGUE_THRESHOLD, complete);
  if (department != null && deptFloor <= largeFloor) throw new PricingConfigError('departmentCatalogueThreshold');
  const steps: CatalogueStep[] = [
    { minItems: 0, tier: 'small', rate: requiredRate(tiers, 'smallVendor') },
    { minItems: largeFloor, tier: 'large', rate: requiredRate(tiers, 'largeVendor') },
  ];
  if (department != null) steps.push({ minItems: deptFloor, tier: 'department', rate: department });
  return steps;
}

/** Every rate the complete card carries. */
const CARD_RATE_KEYS = ['mover', 'moverHeavy', 'taxiDriver', 'serviceVendor', 'smallVendor', 'largeVendor', 'departmentVendor'] as const;

/**
 * A complete card is validated WHOLE before any partner is priced from it:
 * one missing or broken key refuses every quote, signup, activation and
 * re-tier in the market, never just the partner it happened to concern. An
 * incomplete card is not a smaller card; it is no card.
 */
function assertCompleteCard(tiers: SubscriptionTiers): void {
  for (const key of CARD_RATE_KEYS) requiredRate(tiers, key);
  catalogueStepsFor(tiers);
  franchiseRuleFor(tiers);
}

/**
 * The weekly rate a vendor pays.
 *
 * TIER first, then DISCOUNT:
 *   1. The store's own rate — service (no catalogue), else department, large
 *      or small by active listing count. The threshold count itself qualifies.
 *   2. If the owner holds `franchiseMinLocations` or more stores, take
 *      `franchiseDiscountPct` off THAT rate.
 *
 * The discount is deliberately applied to each store's own tier rather than
 * replacing it with a flat bundle: a flat bundle would let a chain of five
 * department stores pay less than a single one, which is not a volume
 * discount, it is a loophole.
 *
 * Every threshold, price and percentage is config. A LEGACY market that has
 * set none of the optional keys behaves exactly as it did before they existed.
 */
function vendorRateFor(tiers: SubscriptionTiers, basis: VendorRateBasis): { rate: number; reason: VendorRateReason; franchised: boolean } {
  let rate: number;
  let reason: VendorRateReason;

  if (basis.isService) {
    rate = optionalRate(tiers, 'serviceVendor', isCompleteCard(tiers)) ?? requiredRate(tiers, 'smallVendor');
    reason = 'service';
  } else {
    const steps = catalogueStepsFor(tiers);
    let step = steps[0]!;
    for (const candidate of steps) if (basis.activeListings >= candidate.minItems) step = candidate;
    rate = step.rate;
    reason = step.tier;
  }

  const franchise = franchiseRuleFor(tiers);
  const franchised = franchise != null && basis.ownedStores >= franchise.minLocations;

  // Round to whole currency units: a weekly fee is a number a shop owner reads
  // off an invoice, and 787.7 is not one. GYD has no subunit in practice, and
  // the column is Decimal(10,2), so this never loses money to rounding drift.
  if (franchised) rate = Math.round(rate * (1 - franchise.discountPct / 100));
  // A "discount" that leaves nothing to pay is a misconfiguration, not a price.
  if (!(rate > 0)) throw new PricingConfigError('franchiseDiscountPct');

  return { rate, reason, franchised };
}

/**
 * The weekly rate a mover pays. The ROLE decides first: a market that sets
 * `taxiDriver` charges every taxi Driver that rate, car or bus. A Rider — and a
 * Driver in a LEGACY market that has not priced taxis apart — pays the band of
 * the vehicle they registered: `moverHeavy` for the heavy fleet, falling back
 * (legacy only) to `mover`, never to zero and never to a code constant.
 */
function moverRateFor(tiers: SubscriptionTiers, role: MoverRole, vehicleType: VehicleType): { rate: number; tier: MoverTier } {
  const complete = isCompleteCard(tiers);
  const heavy = feeBandFor(vehicleType) === 'HEAVY';
  const bandRate = () => (heavy ? optionalRate(tiers, 'moverHeavy', complete) : undefined) ?? requiredRate(tiers, 'mover');
  if (role === 'DRIVER') return { rate: optionalRate(tiers, 'taxiDriver', complete) ?? bandRate(), tier: 'taxi' };
  return { rate: bandRate(), tier: heavy ? 'courierHeavy' : 'courier' };
}

/**
 * THE weekly fee a partner pays — ONE definition. Signup (SubscriptionService),
 * activation preflight, the weekly re-tier (BillingService) and the public
 * price list every app renders all come through here, so the rate a partner
 * is quoted is the rate they are born on and the rate they are billed. A
 * second copy of this logic anywhere is how a quote and a bill drift apart.
 *
 * Throws PricingConfigError rather than ever returning zero, NaN or a guess.
 * A negotiated custom rate or a waived fee is a human decision recorded on the
 * subscription; callers leave those alone and never reach this function for
 * them.
 */
export function partnerRateFor(tiers: SubscriptionTiers, subject: PartnerSubject): PartnerRate {
  if (tiers == null || typeof tiers !== 'object' || Array.isArray(tiers)) throw new PricingConfigError('subscriptionTiers');
  if (isCompleteCard(tiers)) assertCompleteCard(tiers);
  if (subject.kind === 'VENDOR') {
    const { rate, reason, franchised } = vendorRateFor(tiers, subject);
    return { rate, tier: reason, franchised };
  }
  const { rate, tier } = moverRateFor(tiers, subject.kind, subject.vehicleType);
  return { rate, tier, franchised: false };
}

/**
 * Accessor for CountryConfig — currency, ID-gate threshold, subscription
 * tiers, and document checklists all come from here, never from constants.
 * Adding a country must be config, not code.
 */
export class CountryConfigService {
  constructor(private prisma: PrismaClient) {}

  /** `db` may be a caller's transaction, so a read inside one rides its locks. */
  async getByCode(code: string, db: Db = this.prisma): Promise<CountryConfig> {
    const config = await db.countryConfig.findUnique({ where: { code } });
    if (!config) throw new NotFoundError('CountryConfig', code);
    return config;
  }

  /** Countries open for signup; inactive ones show a waitlist. */
  async getActiveCountries() {
    return this.prisma.countryConfig.findMany({
      where: { isActive: true },
      select: { code: true, name: true, currencyCode: true, currencySymbol: true },
      orderBy: { name: 'asc' },
    });
  }

  async getSubscriptionTiers(code: string, db: Db = this.prisma): Promise<SubscriptionTiers> {
    const config = await this.getByCode(code, db);
    return config.subscriptionTiers as unknown as SubscriptionTiers;
  }

  /** The L2 ID-gate threshold converted to local currency. */
  async getIdGateThresholdLocal(code: string): Promise<number> {
    const config = await this.getByCode(code);
    return Number(config.idGateThresholdUsd) * Number(config.usdExchangeRate);
  }

  /** FUL-003b: the food/grocery delivery-fee schedule for a country, merged
   *  over code defaults. Resilient by design — a missing config falls back to
   *  the defaults rather than throwing, so a delivery fee never crashes
   *  checkout (unlike the ID gate, delivery pricing has a safe default). */
  async getDeliveryRates(code: string): Promise<DeliveryRates> {
    // [M-35] Validated and versioned — an invalid column fails closed to the
    // last known good version, a missing country to the defaults. Never throws.
    return (await readDeliveryRates(this.prisma, code)).payload;
  }

  /** Required-document checklist for a role key (drives verification). */
  async getDocumentChecklist(code: string, roleKey: string, tier?: string): Promise<string[]> {
    // [DOC-1 §4.2] The registry speaks first — but only for a requirement set
    // whose every document type is ACTIVE (legal facts verified). Until then
    // the answer is the JSON these lists have always come from: same
    // signature, same lists, no behaviour change (test_checklist_facade_unchanged).
    // [DOC-1 §3.6 · P3-2] At the UNREGISTERED tier the same role reads its
    // <ROLE>_UNREGISTERED list (the registry set at that tier, else the JSON key);
    // a role with no such list is not offered the tier and keeps its standard set.
    const unregistered = tier === UNREGISTERED_TIER;
    const fromRegistry = await registryChecklist(this.prisma, code, roleKey, new Date(), unregistered ? UNREGISTERED_TIER : undefined);
    if (fromRegistry) return fromRegistry;
    const config = await this.getByCode(code);
    const lists = { ...DEFAULT_DOCUMENT_CHECKLISTS, ...((config.documentChecklists ?? {}) as Record<string, string[]>) };
    if (unregistered && lists[`${roleKey}${UNREGISTERED_LIST_SUFFIX}`]) return lists[`${roleKey}${UNREGISTERED_LIST_SUFFIX}`]!;
    return lists[roleKey] ?? [];
  }

  /**
   * Mover checklist, scaled to the vehicle so we never ask for documents a
   * vehicle can't have (a bicycle has no driver's licence or insurance). The
   * document profiles per vehicle live in the vehicle-class taxonomy
   * (config/vehicle-classes) — the single source of truth — so the base three
   * keep their exact lists while new vehicles (buses, box trucks) pull their
   * own profiles (e.g. MOVER_COMMERCIAL) on top of the base:
   *   BICYCLE    → MOVER base (identity + police clearance — master plan §3.2)
   *   MOTORCYCLE → base + MOVER_MOTOR (licence, registration, insurance)
   *   CAR (taxi) → the above + MOVER_TAXI_EXTRA (hire permit, plate photo,
   *                exterior car photo, fitness — master plan §3.1)
   * An unseeded profile key resolves to no extra documents. Used both to display
   * the checklist and to gate live operation.
   */
  async getMoverChecklist(code: string, vehicleType: VehicleType): Promise<string[]> {
    const config = await this.getByCode(code);
    const lists = config.documentChecklists as Record<string, string[]>;
    const base = lists['MOVER'] ?? [];
    const extra = docProfilesFor(vehicleType).flatMap((key) => lists[key] ?? []);
    return [...new Set([...base, ...extra])];
  }
}
