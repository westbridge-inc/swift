import type { VehicleType } from '@prisma/client';
import { VEHICLE_CLASSES, VEHICLE_TYPES_IN_ORDER, feeBandFor, moverRoleFor, type MoverFeeBand, type MoverRole } from '../../config/vehicle-classes';
import {
  DEFAULT_DEPARTMENT_CATALOGUE_THRESHOLD,
  DEFAULT_LARGE_CATALOGUE_THRESHOLD,
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
   * partner at once is the highest of their rates — an older screen may
   * over-state a fee, never under-state one. New clients must not read it.
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
  const floors = [
    0,
    tiers.largeCatalogueThreshold ?? DEFAULT_LARGE_CATALOGUE_THRESHOLD,
    ...(tiers.departmentVendor != null ? [tiers.departmentCatalogueThreshold ?? DEFAULT_DEPARTMENT_CATALOGUE_THRESHOLD] : []),
  ];
  const catalogue = floors.map((minItems): CatalogueBand => {
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
    for (const minItems of floors) partnerRateFor(tiers, { ...chainStore, isService: false, activeListings: minItems });
  }

  const bandMax = (band: MoverFeeBand) => Math.max(...movers.filter((q) => q.band === band).map((q) => q.rate));
  const rateOf = (tier: CatalogueBand['tier']) => catalogue.find((b) => b.tier === tier)?.rate ?? null;

  return {
    movers,
    vendors: { service, catalogue },
    franchise,
    weekly: {
      mover: bandMax('STANDARD'),
      moverHeavy: tiers.moverHeavy != null ? bandMax('HEAVY') : null,
      serviceVendor: tiers.serviceVendor != null ? service : null,
      smallVendor: catalogue[0]!.rate,
      largeVendor: rateOf('large')!,
      departmentVendor: rateOf('department'),
    },
  };
}
