import type { PrismaClient } from '@prisma/client';
import { applySeedPlan, buildSeedPlan, type ApplyOptions, type DesiredConfig, type SeedPlan } from './seed-plan';
import { isProduction } from '../../utils/runtime-mode';

/**
 * The platform SPINE — the rows a Swift database cannot function without,
 * independent of any demo/QA data: the tenant, platform config defaults,
 * every CountryConfig (currency, ID-gate, tiers, checklists), and the launch
 * zones + zone fares.
 *
 * This is the SINGLE source of truth for that spine (CLAUDE rule #17): the dev
 * seed (`seed.ts`) layers demo accounts ON TOP of this, and the production seed
 * (`seed-production.ts`) runs THIS AND NOTHING ELSE. A prod DB with zero
 * CountryConfig rows can't onboard anyone (countryFromPhone rejects every
 * signup), which is exactly what `assertProductionData` (SWIFT-010) fails the
 * boot on — this function is how you satisfy that guard safely.
 *
 * [R048-005] The spine is DATA WITH A VERSION, applied as a PLAN — never a
 * pile of upserts. `desiredPlatformConfig()` is the desired state;
 * `seedPlatformSpine` plans the diff against the target, refuses another
 * database, drift or tampering, needs two approvals on a production target,
 * and lands every change in one locked transaction with an audit row. A
 * replay with nothing to change changes nothing. There is NO schema DDL here:
 * the bookings slot key, PostGIS and the riders GiST index all live in the
 * migration ledger (20260612/20260706/20260826), where reviewed schema belongs.
 */

/** Bump when any value below changes; recorded with every apply. */
export const PLATFORM_CONFIG_VERSION = '2026-09-23.3';

/**
 * The declaration a tier map carries to say it is the COMPLETE partner card:
 * every rate, both catalogue boundaries and the franchise rule are present
 * and valid, and no fallback applies. The resolver
 * (country/country-config.service) refuses a declared card that is missing
 * any key, rather than quietly pricing it as a smaller card; a market that
 * declares nothing keeps the documented legacy fallbacks.
 */
export const COMPLETE_CARD = 'complete';

// Weekly SaaS tiers (GYD) — single source for the GY CountryConfig AND any
// seeded subscription rows, so a tier change never leaves accounts on a stale
// rate. Exported so the dev seed's demo drivers bill at the same rate.
// The owner rate card (2026-09-22): flat weekly fees, independent of sales,
// moved automatically by the weekly re-tier. A delivery/courier Rider pays by
// vehicle band — `mover` for the STANDARD band (bicycle, motorbike), and
// `moverHeavy` for heavy delivery (canters, box trucks) — while every taxi
// Driver pays `taxiDriver`, car or bus. Which band a vehicle falls in and
// which role it provisions is config/vehicle-classes.ts — this file only
// prices them. Every rate is a whole number of dollars.
export const guyanaTiers = {
  card: COMPLETE_CARD,
  mover: 8000,
  moverHeavy: 9000,
  taxiDriver: 9000,
  // Services carry no catalogue — a solo tradesman is not a restaurant.
  serviceVendor: 8000,
  smallVendor: 15000,
  largeVendor: 20000,
  departmentVendor: 60000,
  largeCatalogueThreshold: 1000,
  departmentCatalogueThreshold: 10000,
  // From the 5th store, every location takes 50% off its OWN rate.
  franchiseMinLocations: 5,
  franchiseDiscountPct: 50,
};

// The Guyana rate card every USD-pegged market was launched from. The pegs
// stay on it: re-pricing Guyana re-prices Guyana alone, and moving another
// market's fees is that market's own decision, never a side effect.
const peggedMarketAnchor = {
  mover: 10000,
  moverHeavy: 12000,
  serviceVendor: 12000,
  smallVendor: 20000,
  largeVendor: 30000,
  departmentVendor: 50000,
};

/**
 * The LAUNCH document checklists, as code. The CountryConfig row carries a copy the
 * founder may edit; readers merge these defaults UNDER the stored JSON so a key added
 * here (the UNREGISTERED tier lists, P3-2) exists on every environment without a reseed,
 * while an edited stored list still wins.
 */
export const DEFAULT_DOCUMENT_CHECKLISTS: Record<string, string[]> = {
    MOVER: ['national_id', 'police_clearance'],
    MOVER_MOTOR: ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'],
    MOVER_TAXI_EXTRA: ['hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert'],
    MOVER_COMMERCIAL: ['road_service_licence', 'fitness_cert'],
    RESTAURANT: ['owner_national_id', 'business_registration', 'tin_certificate', 'gra_restaurant_licence', 'food_handler_cert', 'storefront_photo'],
    SUPERMARKET: ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'],
    STORE: ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'],
    // [DOC-1 §3.2/§3.6 · FD-DOC-1 · P3-2] The UNREGISTERED tier of the same roles: identity, the signed
    // self-declaration, the storefront photo, and — never waived — the food handler permit for food.
    // TIN is optional at this tier (not blocking); the restaurant licence is a nudge, not a requirement.
    RESTAURANT_UNREGISTERED: ['owner_national_id', 'self_declaration_unregistered', 'storefront_photo', 'food_handler_cert'],
    SUPERMARKET_UNREGISTERED: ['owner_national_id', 'self_declaration_unregistered', 'storefront_photo'],
    STORE_UNREGISTERED: ['owner_national_id', 'self_declaration_unregistered', 'storefront_photo'],
    SERVICE: ['owner_national_id', 'police_clearance'],
    SERVICE_PROVIDER: ['national_id', 'police_clearance'],
    SERVICE_PROVIDER_TRADE_ELECTRICIAN: ['gei_electrical_licence'],
    SERVICE_PROVIDER_TRADE_ELECTRICAL: ['gei_electrical_licence'],
    CUSTOMER_L2: ['national_id', 'selfie'],
};

/**
 * [DOC-1 §30 · DOC-INV-43] No GYD/USD constant in code. The seed needs ONE anchor to
 * derive every USD-pegged market's local figures and to record the launch market's
 * rate on its CountryConfig row; that anchor comes from the environment
 * (`SEED_FX_GYD_PER_USD`, a dated observation the operator sets). Production refuses
 * to seed without it; outside production the April-2026 observation stands in so
 * dev and test carry the same numbers they always did. Runtime never reads this —
 * every conversion reads `CountryConfig.usdExchangeRate` (the row).
 */
export const SEED_FX_ENV = 'SEED_FX_GYD_PER_USD';
export function seedFxRate(env: Record<string, string | undefined> = process.env): number {
  const raw = env[SEED_FX_ENV];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`[DOC-INV-43] ${SEED_FX_ENV} must be a positive number (GYD per USD); got ${JSON.stringify(raw)}`);
    return n;
  }
  if (isProduction(env)) {
    throw new Error(`[DOC-INV-43] ${SEED_FX_ENV} is required to seed production — the GYD/USD rate is an observation the operator records, never a constant in code.`);
  }
  return 209; // DOC-INV-43 fallback: the April-2026 observation, dev/test only (the census test allowlists this line)
}

/** The desired platform spine, as data. */
export function desiredPlatformConfig(): DesiredConfig {
  const gydPerUsd = seedFxRate();
  // Document checklists are the LAUNCH default. The GEI-licensed electrician
  // entry is the one trade-specific requirement; every other trade falls back
  // to the SERVICE_PROVIDER checklist.
  const guyanaChecklists = DEFAULT_DOCUMENT_CHECKLISTS;
  const guyanaTaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };
  const taxiClassRates = { ECONOMY: 1.0, COMFORT: 1.35, XL: 1.8, GROUP: 2.5 };
  const guyanaCashRules = {
    maxClaimsPerRiderPerMonth: 3,
    strikeRestrictThreshold: 2,
    strikeBanThreshold: 4,
    l3MinPaidOrders: 20,
    l3MinAccountAgeDays: 30,
    outlierMultiplier: 3,
  };
  // [MOB-018] Per-market emergency numbers with a verification record. Only
  // the number the launch market actually verified is marked verified; the
  // rest are carried but flagged, so the SOS ceremony can say so.
  const guyanaEmergency = {
    police: { number: '911', verified: true, verifiedAt: '2026-09-02T00:00:00.000Z', verifiedBy: 'launch-market' },
    fire: { number: '912', verified: false },
    ambulance: { number: '913', verified: false },
  };
  const guyanaRegion = {
    taxiCredentialName: 'Hire Car Licence',
    insuranceClassName: 'Hire',
    verificationSources: ['ID Analyzer', 'GESW', 'GEI registry', 'Police Clearance'],
    regulatoryNotes: 'Data Protection Act 2023 in force; the Nevis entity requires a Guyana local representative.',
    locale: 'en-GY',
  };
  const guyanaPolicy = {
    isActive: true,
    usdExchangeRate: gydPerUsd,
    idGateThresholdUsd: 50,
    floatL1: 8000,
    floatL2: 20000,
    floatL3: 40000,
    subscriptionTiers: guyanaTiers,
    documentChecklists: guyanaChecklists,
    taxiRates: guyanaTaxiRates,
    taxiClassRates,
    cashRules: guyanaCashRules,
    emergency: guyanaEmergency,
    ...guyanaRegion,
  };

  // Future Caribbean market policy is retained so expansion can be planned,
  // reviewed and activated without a data-model rewrite. V1 is Guyana-only:
  // these rows remain explicitly inactive until their own launch gate passes.
  const USD = {
    mover: peggedMarketAnchor.mover / gydPerUsd,
    moverHeavy: peggedMarketAnchor.moverHeavy / gydPerUsd,
    serviceVendor: peggedMarketAnchor.serviceVendor / gydPerUsd,
    smallVendor: peggedMarketAnchor.smallVendor / gydPerUsd,
    largeVendor: peggedMarketAnchor.largeVendor / gydPerUsd,
    departmentVendor: peggedMarketAnchor.departmentVendor / gydPerUsd,
  };
  const USD_TAXI = { base: 1000 / gydPerUsd, perKm: 300 / gydPerUsd, perMin: 25 / gydPerUsd, minimum: 1500 / gydPerUsd };
  const USD_FLOAT = { l1: 8000 / gydPerUsd, l2: 20000 / gydPerUsd, l3: 40000 / gydPerUsd };
  const niceRound = (n: number) => {
    if (n >= 1000) return Math.round(n / 100) * 100;
    if (n >= 100) return Math.round(n / 10) * 10;
    if (n >= 10) return Math.round(n);
    return Math.round(n * 100) / 100;
  };
  const CARIBBEAN: { code: string; name: string; currencyCode: string; currencySymbol: string; rate: number; locale: string }[] = [
    { code: 'TT', name: 'Trinidad & Tobago', currencyCode: 'TTD', currencySymbol: 'TT$', rate: 6.77, locale: 'en-TT' },
    { code: 'JM', name: 'Jamaica', currencyCode: 'JMD', currencySymbol: 'J$', rate: 158, locale: 'en-JM' },
    { code: 'BB', name: 'Barbados', currencyCode: 'BBD', currencySymbol: 'Bds$', rate: 2.0, locale: 'en-BB' },
    { code: 'BS', name: 'Bahamas', currencyCode: 'BSD', currencySymbol: 'B$', rate: 1.0, locale: 'en-BS' },
    { code: 'SR', name: 'Suriname', currencyCode: 'SRD', currencySymbol: 'SRD', rate: 38, locale: 'nl-SR' },
    { code: 'BZ', name: 'Belize', currencyCode: 'BZD', currencySymbol: 'BZ$', rate: 2.0, locale: 'en-BZ' },
    { code: 'GD', name: 'Grenada', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-GD' },
    { code: 'LC', name: 'Saint Lucia', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-LC' },
    { code: 'AG', name: 'Antigua & Barbuda', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-AG' },
    { code: 'VC', name: 'Saint Vincent & the Grenadines', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-VC' },
    { code: 'KN', name: 'Saint Kitts & Nevis', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-KN' },
    { code: 'DM', name: 'Dominica', currencyCode: 'XCD', currencySymbol: 'EC$', rate: 2.7, locale: 'en-DM' },
  ];
  const caribbean = CARIBBEAN.map((c) => {
    const policy = {
      name: c.name,
      currencyCode: c.currencyCode,
      currencySymbol: c.currencySymbol,
      usdExchangeRate: c.rate,
      idGateThresholdUsd: 50,
      floatL1: niceRound(USD_FLOAT.l1 * c.rate),
      floatL2: niceRound(USD_FLOAT.l2 * c.rate),
      floatL3: niceRound(USD_FLOAT.l3 * c.rate),
      subscriptionTiers: {
        mover: niceRound(USD.mover * c.rate),
        moverHeavy: niceRound(USD.moverHeavy * c.rate),
        serviceVendor: niceRound(USD.serviceVendor * c.rate),
        smallVendor: niceRound(USD.smallVendor * c.rate),
        largeVendor: niceRound(USD.largeVendor * c.rate),
        departmentVendor: niceRound(USD.departmentVendor * c.rate),
        largeCatalogueThreshold: guyanaTiers.largeCatalogueThreshold,
        departmentCatalogueThreshold: guyanaTiers.departmentCatalogueThreshold,
        franchiseMinLocations: guyanaTiers.franchiseMinLocations,
        franchiseDiscountPct: guyanaTiers.franchiseDiscountPct,
      },
      documentChecklists: guyanaChecklists,
      taxiRates: {
        base: niceRound(USD_TAXI.base * c.rate),
        perKm: niceRound(USD_TAXI.perKm * c.rate),
        perMin: niceRound(USD_TAXI.perMin * c.rate),
        minimum: niceRound(USD_TAXI.minimum * c.rate),
      },
      taxiClassRates,
      cashRules: guyanaCashRules,
      verificationSources: ['ID Analyzer'],
      regulatoryNotes:
        'Tiers and taxi rates are USD-pegged defaults; document checklist mirrors Guyana. Refine with local business/legal input before launch.',
      locale: c.locale,
      isActive: false,
    };
    return { code: c.code, create: { ...policy }, policy };
  });

  return {
    version: PLATFORM_CONFIG_VERSION,
    platformConfig: [
      { key: 'order_auto_reject_minutes', value: 5 },
      { key: 'delivery_base_fee', value: 500 },
    ],
    countries: [
      {
        code: 'GY',
        create: { name: 'Guyana', currencyCode: 'GYD', currencySymbol: '$', ...guyanaPolicy },
        policy: guyanaPolicy,
      },
      ...caribbean,
    ],
    zones: [
      {
        id: 'georgetown-central',
        create: {
          name: 'Georgetown Central',
          description: 'Central Georgetown delivery zone',
          boundary: { type: 'Polygon', coordinates: [[[-58.18, 6.78], [-58.13, 6.78], [-58.13, 6.83], [-58.18, 6.83], [-58.18, 6.78]]] },
          deliveryBaseFee: 500,
          deliveryPerKm: 200,
        },
      },
      {
        id: 'georgetown-south',
        create: {
          name: 'Georgetown South',
          description: 'South Georgetown taxi zone',
          boundary: { type: 'Polygon', coordinates: [[[-58.18, 6.73], [-58.13, 6.73], [-58.13, 6.78], [-58.18, 6.78], [-58.18, 6.73]]] },
        },
      },
    ],
    // [B5] Rider stacking capacity, founder-gated at 2 (2026-08-29): created
    // once; a later change is an admin decision, never a re-seed.
    algoConfig: [
      { tenantId: 'swift-default', key: 'stacking.riderCapacity', value: 2, founderGated: true, updatedBy: 'seed:founder-directive-2026-08-29' },
    ],
    zoneFares: [
      { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south', fare: 2000 },
      { fromZoneId: 'georgetown-south', toZoneId: 'georgetown-central', fare: 2000 },
    ],
  };
}

export interface SpineOptions extends ApplyOptions {
  /** The database URL the plan is bound to (the target fingerprint is taken from the live connection too). */
  databaseUrl?: string;
  /** Called with the plan before it is applied — the preview a ceremony shows. */
  onPlan?: (plan: SeedPlan) => void | Promise<void>;
}

/**
 * Plan and apply the spine. The default tenant is created if missing (a
 * bootstrap, never an update); everything else is the versioned plan.
 */
export async function seedPlatformSpine(prisma: PrismaClient, opts: SpineOptions = {}): Promise<SeedPlan> {
  const databaseUrl = opts.databaseUrl ?? process.env['DATABASE_URL'] ?? '';
  if (!databaseUrl) throw new Error('[R048-005] seedPlatformSpine needs DATABASE_URL to bind the plan to its target');
  const existing = await prisma.tenant.findUnique({ where: { id: 'swift-default' }, select: { id: true } });
  if (!existing) {
    await prisma.tenant.create({ data: { id: 'swift-default', name: 'Swift', slug: 'swift', isActive: true } });
  }
  const desired = desiredPlatformConfig();
  const plan = await buildSeedPlan(prisma, databaseUrl, desired);
  if (opts.onPlan) await opts.onPlan(plan);
  await applySeedPlan(prisma, databaseUrl, desired, plan, opts);
  return plan;
}
