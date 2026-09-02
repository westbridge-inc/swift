import type { PrismaClient } from '@prisma/client';

/**
 * The platform SPINE — the rows a Swift database cannot function without,
 * independent of any demo/QA data: the tenant, the DB objects `db push` can't
 * express, platform config defaults, every CountryConfig (currency, ID-gate,
 * tiers, checklists), and the launch zones + zone fares.
 *
 * This is the SINGLE source of truth for that spine (CLAUDE rule #17): the dev
 * seed (`seed.ts`) layers demo accounts ON TOP of this, and the production seed
 * (`seed-production.ts`) runs THIS AND NOTHING ELSE. A prod DB with zero
 * CountryConfig rows can't onboard anyone (countryFromPhone rejects every
 * signup), which is exactly what `assertProductionData` (SWIFT-010) fails the
 * boot on — this function is how you satisfy that guard safely.
 */

// Weekly SaaS tiers (GYD) — single source for the GY CountryConfig AND any
// seeded subscription rows, so a tier change never leaves accounts on a stale
// rate. Exported so the dev seed's demo drivers bill at the same rate.
// `mover` is the STANDARD fee band (bicycle, motorbike, car, wagon car);
// `moverHeavy` is the HEAVY band (buses, canters, box trucks). Which band a
// vehicle falls in is config/vehicle-classes.ts — this file only prices them.
export const guyanaTiers = {
  mover: 10000,
  moverHeavy: 12000,
  // Services carry no catalogue — a solo tradesman is not a restaurant.
  serviceVendor: 12000,
  smallVendor: 20000,
  largeVendor: 30000,
  departmentVendor: 50000,
  largeCatalogueThreshold: 1000,
  departmentCatalogueThreshold: 10000,
  // From the 5th store, every location takes 50% off its OWN rate. At the
  // standard shop rate that is exactly 50,000/week for five locations.
  franchiseMinLocations: 5,
  franchiseDiscountPct: 50,
};

export async function seedPlatformSpine(prisma: PrismaClient): Promise<void> {
  // The single current SaaS tenant MUST exist before any tenant-owned row
  // (users/vendors/orders default their tenantId to it via FK), so the tenant
  // is created here first, before anything that references it.
  await prisma.tenant.upsert({
    where: { id: 'swift-default' },
    update: {},
    create: { id: 'swift-default', name: 'Swift', slug: 'swift', isActive: true },
  });

  // Partial unique index Prisma cannot express: one LIVE booking per item per
  // slot (CANCELLED frees the slot). Idempotent, so it is harmless alongside
  // the migration that also creates it.
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "bookings_item_slot_live_key"
    ON "bookings"("itemId", "slotStart") WHERE "status" <> 'CANCELLED'
  `;

  // PostGIS + the dispatch candidate index. Idempotent (IF NOT EXISTS), so it
  // is a no-op on a migrated database and a safety net on any other.
  await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS postgis`;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS "riders_geo_gist"
    ON "riders" USING GIST (geography(ST_MakePoint("currentLng", "currentLat")))
    WHERE "isOnline" = true AND "currentLat" IS NOT NULL AND "currentLng" IS NOT NULL
  `;

  // Platform config defaults — ONLY keys production code actually reads.
  //
  // This list used to seed 22 keys; 20 were read by nothing while the admin
  // config page rendered them as working controls (the 19-field lying panel,
  // master audit G10). Fares and fees live in CountryConfig per market;
  // cancellation and dispatch numbers are shipped constants. A key belongs
  // here ONLY together with the code that reads it — the namespaced
  // billing.mmg_agent.* keys (seeded where they are used) are the pattern.
  //
  // delivery_base_fee stays for now: admin-audit.test.ts uses it as the
  // fixture for the config-write audit trail. Nothing else reads it.
  // Stacking capacity — founder directive 2026-08-29: "riders and delivery
  // guys can accept multiple orders, only taxis can't". Written as version 1
  // of the AlgoConfig key the concurrency seam reads; a higher-version row
  // with value 1 is the no-deploy kill switch. create-if-absent so replays
  // never clobber a later founder-set version.
  const stackingRow = await prisma.algoConfig.findFirst({
    where: { tenantId: 'swift-default', key: 'stacking.riderCapacity' },
    select: { id: true },
  });
  if (!stackingRow) {
    await prisma.algoConfig.create({
      data: {
        tenantId: 'swift-default',
        key: 'stacking.riderCapacity',
        value: 2,
        version: 1,
        founderGated: true,
        updatedBy: 'seed:founder-directive-2026-08-29',
      },
    });
  }

  const configs = [
    { key: 'order_auto_reject_minutes', value: 5 },
    { key: 'delivery_base_fee', value: 500 },
  ];
  for (const config of configs) {
    await prisma.platformConfig.upsert({
      where: { key: config.key },
      update: { value: config.value },
      create: { key: config.key, value: config.value },
    });
  }

  // Guyana CountryConfig — the single source for currency, ID-gate, tiers,
  // and document checklists. Adding a country = adding a row, not code.
  const guyanaChecklists = {
    // Every mover (incl. bicycle couriers) proves identity AND character —
    // couriers handle cash and walk up to homes, so the Police Clearance
    // (Certificate of Character) applies to ALL of them (master plan §3.2:
    // only licence/registration/insurance are motorized-only).
    MOVER: ['national_id', 'police_clearance'],
    // Motor vehicles (motorcycle + car) add licence, registration, insurance.
    MOVER_MOTOR: ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'],
    // Taxi drivers carry passengers — heaviest checklist: occupational permit,
    // H-plate photo, exterior car photo with the H plate + corporate-yellow
    // paint visible (master plan §3.1), and an annual fitness certificate.
    MOVER_TAXI_EXTRA: ['hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert'],
    // Commercial goods/passenger vehicles (canters, box trucks, buses) run under
    // a Road Service Licence and carry an annual Certificate of Fitness on top of
    // the base motor documents. (fitness_cert reuses the taxi key so a bus that is
    // both hire + commercial uploads it once.)
    MOVER_COMMERCIAL: ['road_service_licence', 'fitness_cert'],
    // Commerce operators (master plan §3.3–3.5): registration + TIN for every
    // business; restaurants add the GRA eating-house licence + food handler
    // cert; every storefront photographs its premises (shown to customers).
    RESTAURANT: ['owner_national_id', 'business_registration', 'tin_certificate', 'gra_restaurant_licence', 'food_handler_cert', 'storefront_photo'],
    SUPERMARKET: ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'],
    STORE: ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'],
    // SERVICE-type vendor owners meet the same bar as individual providers
    // (§3.6): identity + police clearance (they enter customers' homes).
    SERVICE: ['owner_national_id', 'police_clearance'],
    // Hire-a-professional providers (§4.6): ID + police clearance are mandatory.
    SERVICE_PROVIDER: ['national_id', 'police_clearance'],
    // Trade-mandated extensions (spec §3.5): electrical work is illegal in
    // Guyana without a GEI Electrical Contractor Licence (Electricity Sector
    // Reform Act 1999) — for electricians it is a GATE, not a badge. Every
    // other trade is ID-only by law; qualifications stay opt-in badges.
    SERVICE_PROVIDER_TRADE_ELECTRICIAN: ['gei_electrical_licence'],
    SERVICE_PROVIDER_TRADE_ELECTRICAL: ['gei_electrical_licence'],
    CUSTOMER_L2: ['national_id', 'selfie'],
  };
  const guyanaTaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };
  // Per-tier multipliers on the base (Economy) fare — country-independent.
  const taxiClassRates = { ECONOMY: 1.0, COMFORT: 1.35, XL: 1.8, GROUP: 2.5 };
  const guyanaCashRules = {
    maxClaimsPerRiderPerMonth: 3,
    strikeRestrictThreshold: 2,
    strikeBanThreshold: 4,
    l3MinPaidOrders: 20,
    l3MinAccountAgeDays: 30,
    outlierMultiplier: 3,
  };
  // [MOB-018] The launch market's emergency numbers. Police 911 is what the app
  // has always dialed and is the one VERIFIED entry; fire and ambulance are
  // Guyana's published numbers, offered with a confirm until ops verifies them
  // on a device (a market fact, never a code fact).
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
  await prisma.countryConfig.upsert({
    where: { code: 'GY' },
    update: {
      isActive: true,
      usdExchangeRate: 209.0,
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
    },
    create: {
      code: 'GY',
      name: 'Guyana',
      currencyCode: 'GYD',
      currencySymbol: '$',
      usdExchangeRate: 209.0,
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
      isActive: true,
    },
  });

  // ── Additional CARIBBEAN markets (multi-country foundation) ──────────────────
  // FACTUAL (Jun 2026): code/name/currency/symbol/usdExchangeRate are real; BBD/BSD/
  // BZD/XCD are hard USD pegs. DEFAULTS to refine per market with local business/legal
  // input: subscription tiers + taxi rates are USD-pegged off Guyana's; documentChecklists
  // and cashRules reuse Guyana's as a template. (Dial codes live in the /auth/countries map.)
  const USD = {
    mover: guyanaTiers.mover / 209,
    moverHeavy: guyanaTiers.moverHeavy / 209,
    serviceVendor: guyanaTiers.serviceVendor / 209,
    smallVendor: guyanaTiers.smallVendor / 209,
    largeVendor: guyanaTiers.largeVendor / 209,
    departmentVendor: guyanaTiers.departmentVendor / 209,
  };
  const USD_TAXI = { base: 1000 / 209, perKm: 300 / 209, perMin: 25 / 209, minimum: 1500 / 209 };
  // D.3 float limits, USD-pegged off Guyana's (L1 8000 / L2 20000 / L3 40000 GYD).
  const USD_FLOAT = { l1: 8000 / 209, l2: 20000 / 209, l3: 40000 / 209 };
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
  for (const c of CARIBBEAN) {
    const data = {
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
        // Catalogue sizes are counts, not money — they never convert.
        largeCatalogueThreshold: guyanaTiers.largeCatalogueThreshold,
        departmentCatalogueThreshold: guyanaTiers.departmentCatalogueThreshold,
        // A count and a percentage — neither is money, so neither converts.
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
      // Whole-Caribbean availability (founder directive 2026-07-12): partners
      // sign up from any island and start; per-country ops polish follows.
      isActive: true,
    };
    await prisma.countryConfig.upsert({ where: { code: c.code }, update: data, create: { code: c.code, ...data } });
  }

  // Launch zones (Georgetown) + one zone-to-zone fixed fare so the table-hit
  // path is live. Real delivery/taxi operation needs at least one zone.
  await prisma.zone.upsert({
    where: { id: 'georgetown-central' },
    update: {},
    create: {
      id: 'georgetown-central',
      name: 'Georgetown Central',
      description: 'Central Georgetown delivery zone',
      boundary: { type: 'Polygon', coordinates: [[[-58.18, 6.78], [-58.13, 6.78], [-58.13, 6.83], [-58.18, 6.83], [-58.18, 6.78]]] },
      deliveryBaseFee: 500,
      deliveryPerKm: 200,
    },
  });
  await prisma.zone.upsert({
    where: { id: 'georgetown-south' },
    update: {},
    create: {
      id: 'georgetown-south',
      name: 'Georgetown South',
      description: 'South Georgetown taxi zone',
      boundary: { type: 'Polygon', coordinates: [[[-58.18, 6.73], [-58.13, 6.73], [-58.13, 6.78], [-58.18, 6.78], [-58.18, 6.73]]] },
    },
  });
  const zoneFareExists = await prisma.zoneFare.findFirst({
    where: { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south' },
  });
  if (!zoneFareExists) {
    await prisma.zoneFare.createMany({
      data: [
        { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south', fare: 2000 },
        { fromZoneId: 'georgetown-south', toZoneId: 'georgetown-central', fare: 2000 },
      ],
    });
  }
}
