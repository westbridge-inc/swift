import type { PrismaClient, CountryConfig, VehicleType } from '@prisma/client';
import { registryChecklist } from '../verification/doc-registry';
import { NotFoundError } from '../../utils/errors';
import type { DeliveryRates } from '../../utils/markup';
import { readDeliveryRates } from './pricing-config';
import { docProfilesFor, feeBandFor } from '../../config/vehicle-classes';

/** Weekly subscription tiers in local currency. */
export interface SubscriptionTiers {
  /** STANDARD fee band — bicycle, motorbike, car, wagon car. */
  mover: number;
  /** HEAVY fee band — buses, canters, box trucks. Absent in a market that has
   *  not set it, which `moverRateFor` resolves back to `mover`. */
  moverHeavy?: number;
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

export interface VendorRate {
  /** What this store owes per week, discount already applied. */
  rate: number;
  /** The tier the rate was built from. */
  reason: VendorRateReason;
  /** Whether the franchise discount was applied. */
  franchised: boolean;
}

/**
 * The weekly rate a vendor pays. ONE definition, shared by signup and the
 * weekly re-tier, for the same reason `moverRateFor` is: a rate quoted at
 * signup that disagrees with the rate billing later decides is a support
 * incident, not a rounding difference.
 *
 * TIER first, then DISCOUNT:
 *   1. The store's own rate — service (no catalogue), else department, large
 *      or small by active listing count. The threshold count itself qualifies.
 *   2. If the owner holds `franchiseMinLocations` or more stores, take
 *      `franchiseDiscountPct` off THAT rate.
 *
 * The discount is deliberately applied to each store's own tier rather than
 * replacing it with a flat bundle. At the standard shop rate the two are
 * identical — five shops at 20,000 less 50% is the 50,000-for-five bundle —
 * but a flat bundle would also let a chain of five department stores pay less
 * than a single one, which is not a volume discount, it is a loophole.
 *
 * Every threshold, price and percentage is config. A market that has set none
 * of the optional keys behaves exactly as it did before they existed.
 */
export function vendorRateFor(tiers: SubscriptionTiers, basis: VendorRateBasis): VendorRate {
  let rate: number;
  let reason: VendorRateReason;

  if (basis.isService) {
    rate = tiers.serviceVendor ?? tiers.smallVendor;
    reason = 'service';
  } else {
    const deptFloor = tiers.departmentCatalogueThreshold ?? DEFAULT_DEPARTMENT_CATALOGUE_THRESHOLD;
    const largeFloor = tiers.largeCatalogueThreshold ?? DEFAULT_LARGE_CATALOGUE_THRESHOLD;
    if (tiers.departmentVendor != null && basis.activeListings >= deptFloor) {
      rate = tiers.departmentVendor;
      reason = 'department';
    } else if (basis.activeListings >= largeFloor) {
      rate = tiers.largeVendor;
      reason = 'large';
    } else {
      rate = tiers.smallVendor;
      reason = 'small';
    }
  }

  const { franchiseMinLocations: minStores, franchiseDiscountPct: pct } = tiers;
  const franchised =
    minStores != null && pct != null && minStores > 0 && pct > 0 && basis.ownedStores >= minStores;

  // Round to whole currency units: a weekly fee is a number a shop owner reads
  // off an invoice, and 787.7 is not one. GYD has no subunit in practice, and
  // the column is Decimal(10,2), so this never loses money to rounding drift.
  if (franchised) rate = Math.round(rate * (1 - pct / 100));

  return { rate, reason, franchised };
}

/**
 * The weekly rate a mover pays, given the vehicle they registered.
 *
 * ONE definition. Signup (SubscriptionService) and the weekly re-tier
 * (BillingService) must both come through here, or a mover's rate at signup
 * can drift from the rate the billing run later decides they owe.
 *
 * A market that has not set `moverHeavy` falls back to the standard rate —
 * never to zero, and never to a code constant.
 */
export function moverRateFor(tiers: SubscriptionTiers, vehicleType: VehicleType): number {
  return feeBandFor(vehicleType) === 'HEAVY' ? (tiers.moverHeavy ?? tiers.mover) : tiers.mover;
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
  async getDocumentChecklist(code: string, roleKey: string): Promise<string[]> {
    // [DOC-1 §4.2] The registry speaks first — but only for a requirement set
    // whose every document type is ACTIVE (legal facts verified). Until then
    // the answer is the JSON these lists have always come from: same
    // signature, same lists, no behaviour change (test_checklist_facade_unchanged).
    const fromRegistry = await registryChecklist(this.prisma, code, roleKey);
    if (fromRegistry) return fromRegistry;
    const config = await this.getByCode(code);
    const lists = config.documentChecklists as Record<string, string[]>;
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
