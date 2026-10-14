import type { VehicleType } from '@prisma/client';
import { VEHICLE_CLASSES, VEHICLE_TYPES_IN_ORDER, feeBandFor, isVehicleOffered, moverRoleFor, type MoverFeeBand, type MoverRole } from '../../config/vehicle-classes';
import {
  catalogueStepsFor,
  partnerRateFor,
  PricingConfigError,
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
  /** [Launch vehicle list] Whether a mover can register or switch to this vehicle
   *  today (config/vehicle-classes isVehicleOffered). Every vehicle is still priced,
   *  so the list stays complete; the picker shows only the offered ones. */
  offered: boolean;
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
  /**
   * @deprecated Always null. [Owner, 13 Oct 2026 — decision 49] Swift has no
   * multi-store pricing: every store is its own account and pays its own tier.
   * Kept as an explicit null so a client that reads the key (the web page and
   * the app shipped it in their types) reads "no franchise pricing".
   */
  franchise: null;
  /**
   * @deprecated Compatibility for apps that predate `movers`/`vendors`. Each
   * legacy number is nonzero, and one an older app shows to several kinds of
   * partner at once is the HIGHEST of their bills — an older screen may
   * over-state a fee, never under-state one. Concretely, for the card those
   * apps shipped: `mover` is shown to every mover, so it is the highest rate
   * of a vehicle a mover can register today (`offered`); `smallVendor` is
   * shown to every business as its price, so it is the highest rate a store
   * under 1,000 items can be billed; `largeVendor` is shown as "1000+ items",
   * so it is the highest rate any store from 1,000 items up can be billed —
   * the department bill, where the market has one. A vehicle Swift does not
   * take on (heavy delivery at launch, owner 13 Oct 2026 — decision 48) has
   * no door price, so its rate is in none of these figures. New clients must
   * not read it.
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
    return { vehicleType, label: VEHICLE_CLASSES[vehicleType].label, role, band: feeBandFor(vehicleType), tier: tier as MoverTier, rate, offered: isVehicleOffered(vehicleType) };
  });

  // Each store is priced on its own catalogue alone (owner, 13 Oct 2026).
  const vendorAt = (isService: boolean, activeListings: number) =>
    partnerRateFor(tiers, { kind: 'VENDOR', isService, activeListings });
  // The steps are the biller's own validated ladder; each is then priced
  // through the biller, so a quoted step is a billed step.
  const catalogue = catalogueStepsFor(tiers).map(({ minItems }): CatalogueBand => {
    const { rate, tier } = vendorAt(false, minItems);
    return { minItems, tier: tier as CatalogueBand['tier'], rate };
  });
  const service = vendorAt(true, 0).rate;

  // Legacy figures: the highest bill each one can stand for (see `weekly`),
  // over the vehicles a mover can register today. Every vehicle stays in
  // `movers` with its `offered` flag — the app hides a vehicle by that flag,
  // so dropping one would make an older app fall back to its own list.
  const highest = (rates: number[]) => Math.max(...rates);
  const offered = movers.filter((q) => q.offered);
  const quotable = offered.length > 0 ? offered : movers;
  const heavyOffered = quotable.filter((q) => q.band === 'HEAVY');
  // Steps a store below `below` items can be on, and steps a store from `from` items up can be on.
  const stepsBelow = (below: number) => catalogue.filter((band) => band.minItems < below);
  const stepsFrom = (from: number) => catalogue.filter((_band, i) => (catalogue[i + 1]?.minItems ?? Number.POSITIVE_INFINITY) > from);

  return {
    movers,
    vendors: { service, catalogue },
    franchise: null,
    weekly: {
      mover: highest(quotable.map((q) => q.rate)),
      moverHeavy: tiers.moverHeavy != null && heavyOffered.length > 0 ? highest(heavyOffered.map((q) => q.rate)) : null,
      serviceVendor: tiers.serviceVendor != null ? service : null,
      smallVendor: highest(stepsBelow(LEGACY_LARGE_CATALOGUE_FROM).map((band) => band.rate)),
      largeVendor: highest(stepsFrom(LEGACY_LARGE_CATALOGUE_FROM).map((band) => band.rate)),
      departmentVendor: catalogue.find((band) => band.tier === 'department')?.rate ?? null,
    },
  };
}
