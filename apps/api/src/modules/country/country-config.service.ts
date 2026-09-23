import type { PrismaClient, CountryConfig, VehicleType } from '@prisma/client';
import { registryChecklist, UNREGISTERED_LIST_SUFFIX, UNREGISTERED_TIER } from '../verification/doc-registry';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../ops/platform-config';
import { AppError, NotFoundError } from '../../utils/errors';
import type { DeliveryRates } from '../../utils/markup';
import { readDeliveryRates } from './pricing-config';
import { docProfilesFor, feeBandFor, type MoverRole } from '../../config/vehicle-classes';

/** Weekly subscription tiers in local currency. */
export interface SubscriptionTiers {
  /** STANDARD fee band — a delivery/courier Rider on a bicycle or motorbike
   *  (and, where `taxiDriver` is absent, a Driver on a car or wagon car). */
  mover: number;
  /** HEAVY fee band — heavy delivery on a canter or box truck (and, where
   *  `taxiDriver` is absent, a Driver on a bus). Absent in a market that has
   *  not set it, which resolves back to `mover`. */
  moverHeavy?: number;
  /** Every taxi Driver, whatever the vehicle. Absent in a market that has not
   *  priced taxis apart, where a Driver pays the band rate like everyone else. */
  taxiDriver?: number;
  /** Services with no catalogue — a plumber, electrician or barber. Falls back
   *  to `smallVendor` in a market that has not priced services separately. */
  serviceVendor?: number;
  /** Standard catalogue, below `largeCatalogueThreshold` items. */
  smallVendor: number;
  /** At or above `largeCatalogueThreshold` items. */
  largeVendor: number;
  /** Department-store scale — at or above `departmentCatalogueThreshold`. */
  departmentVendor?: number;
  largeCatalogueThreshold?: number;
  departmentCatalogueThreshold?: number;
  /** Franchise: from `franchiseMinLocations` stores under one owner, every
   *  location takes `franchiseDiscountPct` off ITS OWN rate. Both must be set
   *  for franchise pricing to apply at all. */
  franchiseMinLocations?: number;
  franchiseDiscountPct?: number;
  [tier: string]: number | undefined;
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
 * negative or non-numeric rate, a nonsensical catalogue boundary, or a
 * discount that leaves nothing to pay. Signup refuses, the re-tier holds the
 * current rate, and the public list refuses to quote: an unknown price is an
 * error, never a free subscription.
 */
export class PricingConfigError extends AppError {
  constructor(key: string) {
    super(500, 'PRICING_CONFIG_INVALID', `Weekly-fee config "${key}" is missing or is not a positive amount`, { key });
    this.name = 'PricingConfigError';
  }
}

/** A configured rate: a finite amount above zero, or the config is refused. */
function requiredRate(tiers: SubscriptionTiers, key: string): number {
  const value: unknown = tiers[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new PricingConfigError(key);
  return value;
}

/** An optional rate: absent means "not priced apart"; present must be valid. */
function optionalRate(tiers: SubscriptionTiers, key: string): number | undefined {
  return tiers[key] == null ? undefined : requiredRate(tiers, key);
}

/** A catalogue boundary is a whole number of items above zero. */
function catalogueFloor(tiers: SubscriptionTiers, key: string, fallback: number): number {
  const value: unknown = tiers[key];
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new PricingConfigError(key);
  return value;
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
 * Null when the market has none: either key absent, or a zero discount. A
 * location count that is not a whole number of stores, or a discount that is
 * negative, not a number, or leaves nothing to pay, is a broken market.
 */
export function franchiseRuleFor(tiers: SubscriptionTiers): FranchiseRule | null {
  const minLocations: unknown = tiers.franchiseMinLocations;
  const discountPct: unknown = tiers.franchiseDiscountPct;
  if (minLocations == null || discountPct == null) return null;
  if (typeof minLocations !== 'number' || !Number.isInteger(minLocations) || minLocations < 1) {
    throw new PricingConfigError('franchiseMinLocations');
  }
  if (typeof discountPct !== 'number' || !Number.isFinite(discountPct) || discountPct < 0 || discountPct >= 100) {
    throw new PricingConfigError('franchiseDiscountPct');
  }
  return discountPct > 0 ? { minLocations, discountPct } : null;
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
 * Every threshold, price and percentage is config. A market that has set none
 * of the optional keys behaves exactly as it did before they existed.
 */
function vendorRateFor(tiers: SubscriptionTiers, basis: VendorRateBasis): { rate: number; reason: VendorRateReason; franchised: boolean } {
  let rate: number;
  let reason: VendorRateReason;

  if (basis.isService) {
    rate = optionalRate(tiers, 'serviceVendor') ?? requiredRate(tiers, 'smallVendor');
    reason = 'service';
  } else {
    const largeFloor = catalogueFloor(tiers, 'largeCatalogueThreshold', DEFAULT_LARGE_CATALOGUE_THRESHOLD);
    const department = optionalRate(tiers, 'departmentVendor');
    const deptFloor = catalogueFloor(tiers, 'departmentCatalogueThreshold', DEFAULT_DEPARTMENT_CATALOGUE_THRESHOLD);
    // A department step at or below the large one would leave the large tier
    // unreachable and the public ladder out of order.
    if (department != null && deptFloor <= largeFloor) throw new PricingConfigError('departmentCatalogueThreshold');
    if (department != null && basis.activeListings >= deptFloor) {
      rate = department;
      reason = 'department';
    } else if (basis.activeListings >= largeFloor) {
      rate = requiredRate(tiers, 'largeVendor');
      reason = 'large';
    } else {
      rate = requiredRate(tiers, 'smallVendor');
      reason = 'small';
    }
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
 * Driver in a market that has not priced taxis apart — pays the band of the
 * vehicle they registered: `moverHeavy` for the heavy fleet, falling back to
 * `mover`, never to zero and never to a code constant.
 */
function moverRateFor(tiers: SubscriptionTiers, role: MoverRole, vehicleType: VehicleType): { rate: number; tier: MoverTier } {
  const heavy = feeBandFor(vehicleType) === 'HEAVY';
  const bandRate = () => (heavy ? optionalRate(tiers, 'moverHeavy') : undefined) ?? requiredRate(tiers, 'mover');
  if (role === 'DRIVER') return { rate: optionalRate(tiers, 'taxiDriver') ?? bandRate(), tier: 'taxi' };
  return { rate: bandRate(), tier: heavy ? 'courierHeavy' : 'courier' };
}

/**
 * THE weekly fee a partner pays — ONE definition. Signup (SubscriptionService),
 * the weekly re-tier (BillingService) and the public price list every app
 * renders all come through here, so the rate a partner is quoted is the rate
 * they are born on and the rate they are billed. A second copy of this logic
 * anywhere is how a quote and a bill drift apart.
 *
 * Throws PricingConfigError rather than ever returning zero, NaN or a guess.
 * A negotiated custom rate or a waived fee is a human decision recorded on the
 * subscription; callers leave those alone and never reach this function for
 * them.
 */
export function partnerRateFor(tiers: SubscriptionTiers, subject: PartnerSubject): PartnerRate {
  if (tiers == null || typeof tiers !== 'object' || Array.isArray(tiers)) throw new PricingConfigError('subscriptionTiers');
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

  async getByCode(code: string): Promise<CountryConfig> {
    const config = await this.prisma.countryConfig.findUnique({ where: { code } });
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

  async getSubscriptionTiers(code: string): Promise<SubscriptionTiers> {
    const config = await this.getByCode(code);
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
