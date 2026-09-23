import type { VehicleType } from '@prisma/client';
import { VEHICLE_CLASSES, VEHICLE_TYPES_IN_ORDER, feeBandFor, moverRoleFor, type MoverFeeBand, type MoverRole } from '../../config/vehicle-classes';
import {
  catalogueStepsFor,
  franchiseRuleFor,
  partnerRateFor,
  PricingConfigError,
  type FranchiseRule,
  type MoverTier,
  type SubscriptionTiers,
  type VendorRateReason,
} from './country-config.service';

/** One vehicle a mover can register, priced for the role it provisions. */
export interface MoverQuote {
  vehicleType: VehicleType;
  label: string;
  role: MoverRole;
  band: MoverFeeBand;
  tier: MoverTier;
  rate: number;
}

/** One catalogue step: from `minItems` active items, `rate` per week. */
export interface CatalogueBand {
  minItems: number;
  tier: Exclude<VendorRateReason, 'service'>;
  rate: number;
}

/**
 * Where the client that predates `vendors.catalogue` split its two business
 * figures: its onboarding card read `weekly.smallVendor` as "then X/week" for
 * every business and `weekly.largeVendor` as "Large catalogues (1000+ items)".
 * That 1,000 was the client's own copy, not the market's boundary, so the
 * legacy figures are built around it here rather than around
 * `largeCatalogueThreshold`.
 */
const LEGACY_LARGE_CATALOGUE_FROM = 1000;

/**
 * The partner price list the public endpoint serves — every number in it is
 * the output of `partnerRateFor`, the function signup and the weekly re-tier
 * bill through, so what a partner is quoted is what they are billed.
 */
export interface PartnerPriceList {
  /** Every vehicle in the fleet, in picker order. */
  movers: MoverQuote[];
  /** Services are flat; catalogue businesses step up by active items. */
  vendors: { service: number; catalogue: CatalogueBand[] };
  /** The franchise rule — a discount on each location's own rate — exactly as
   *  the biller applies it; null when the market has none. */
  franchise: FranchiseRule | null;
  /**
   * @deprecated Compatibility for apps that predate `movers`/`vendors`. Each
   * legacy number is nonzero, and one an older app shows to several kinds of
   * partner at once is the HIGHEST of their bills — an older screen may
   * over-state a fee, never under-state one. Concretely, for the card those
   * apps shipped: `mover` is shown to every mover, so it is the highest mover
   * rate; `smallVendor` is shown to every business as its price, so it is the
   * highest rate a store under 1,000 items can be billed; `largeVendor` is
   * shown as "1000+ items", so it is the highest rate any store from 1,000
   * items up can be billed — the department bill, where the market has one.
   * New clients must not read it.
   */
  weekly: {
    mover: number;
    moverHeavy: number | null;
    serviceVendor: number | null;
    smallVendor: number;
    largeVendor: number;
    departmentVendor: number | null;
  };
}

/** Build the whole list or refuse: a market that cannot price every partner
 *  quotes nobody, rather than a partial list with holes read as "free". */
export function partnerPriceList(rawTiers: unknown): PartnerPriceList {
  if (rawTiers == null || typeof rawTiers !== 'object' || Array.isArray(rawTiers)) throw new PricingConfigError('subscriptionTiers');
  const tiers = rawTiers as SubscriptionTiers;

  const movers = VEHICLE_TYPES_IN_ORDER.map((vehicleType): MoverQuote => {
    const role = moverRoleFor(vehicleType);
    const { rate, tier } = partnerRateFor(tiers, { kind: role, vehicleType });
    return { vehicleType, label: VEHICLE_CLASSES[vehicleType].label, role, band: feeBandFor(vehicleType), tier: tier as MoverTier, rate };
  });

  // One store, no franchise: the franchise rule is quoted as a rule below.
  const vendorAt = (isService: boolean, activeListings: number) =>
    partnerRateFor(tiers, { kind: 'VENDOR', isService, activeListings, ownedStores: 1 });
  // The steps are the biller's own validated ladder; each is then priced
  // through the biller, so a quoted step is a billed step.
  const catalogue = catalogueStepsFor(tiers).map(({ minItems }): CatalogueBand => {
    const { rate, tier } = vendorAt(false, minItems);
    return { minItems, tier: tier as CatalogueBand['tier'], rate };
  });
  const service = vendorAt(true, 0).rate;

  // The quoted franchise rule must be billable at every step: price one chain
  // store per step through the biller, which refuses a discount that leaves
  // nothing to pay — so the list refuses it too, instead of quoting it.
  const franchise = franchiseRuleFor(tiers);
  if (franchise) {
    const chainStore = { kind: 'VENDOR', ownedStores: franchise.minLocations } as const;
    partnerRateFor(tiers, { ...chainStore, isService: true, activeListings: 0 });
    for (const { minItems } of catalogue) partnerRateFor(tiers, { ...chainStore, isService: false, activeListings: minItems });
  }

  // Legacy figures: the highest bill each one can stand for (see `weekly`).
  const highest = (rates: number[]) => Math.max(...rates);
  // Steps a store below `below` items can be on, and steps a store from `from` items up can be on.
  const stepsBelow = (below: number) => catalogue.filter((band) => band.minItems < below);
  const stepsFrom = (from: number) => catalogue.filter((_band, i) => (catalogue[i + 1]?.minItems ?? Number.POSITIVE_INFINITY) > from);

  return {
    movers,
    vendors: { service, catalogue },
    franchise,
    weekly: {
      mover: highest(movers.map((q) => q.rate)),
      moverHeavy: tiers.moverHeavy != null ? highest(movers.filter((q) => q.band === 'HEAVY').map((q) => q.rate)) : null,
      serviceVendor: tiers.serviceVendor != null ? service : null,
      smallVendor: highest(stepsBelow(LEGACY_LARGE_CATALOGUE_FROM).map((band) => band.rate)),
      largeVendor: highest(stepsFrom(LEGACY_LARGE_CATALOGUE_FROM).map((band) => band.rate)),
      departmentVendor: catalogue.find((band) => band.tier === 'department')?.rate ?? null,
    },
  };
}
