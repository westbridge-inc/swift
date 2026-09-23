import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient, VehicleType } from '@prisma/client';

// ---------------------------------------------------------------------------
// The Guyana partner weekly fee is ONE contract: the number the public price
// list quotes, the number signup writes, and the number the weekly re-tier
// bills must be the same number, for every kind of partner.
//
// Owner rate card (GYD per week, flat, independent of sales):
//   delivery/courier rider on a standard vehicle   8,000
//   heavy delivery (canters, box trucks)            9,000
//   taxi driver (any vehicle)                        9,000
//   service provider                                8,000
//   restaurant/store/grocery, < 1,000 active items  15,000
//   1,000–9,999 active items                        20,000
//   10,000+ active items                            60,000
//
// Service-free: every database call below is an in-memory fake, and the
// trial-law, SAN and float collaborators are stubbed. Nothing opens Postgres,
// Redis or a provider.
// ---------------------------------------------------------------------------

vi.mock('../modules/integrity/trial-entitlement.service', () => ({
  TrialEntitlementService: class {
    async decide() {
      return { grant: true, reason: 'FIRST_TRIAL', clusterId: 'cluster-test' };
    }
    async recordGrant() {
      return undefined;
    }
  },
}));
vi.mock('../modules/billing/san.service', () => ({ ensureSan: async () => '0000000000' }));
vi.mock('../modules/dispatch/float.service', () => ({
  FloatService: class {
    async recomputeForUser() {
      return undefined;
    }
  },
}));

import { desiredPlatformConfig, PLATFORM_CONFIG_VERSION } from '../modules/ops/platform-config';
import { VEHICLE_CLASSES, VEHICLE_TYPES_IN_ORDER, feeBandFor } from '../config/vehicle-classes';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { BillingService } from '../modules/billing/billing.service';
import { PartnerService } from '../modules/partner/partner.service';
import type { NotificationService } from '../modules/notification/notification.service';
import type { PaymentProvider } from '../providers/payment/payment-provider';
import { authRoutes } from '../modules/auth/auth.routes';
import * as pricing from '../modules/country/country-config.service';
import { partnerPriceList } from '../modules/country/partner-pricing';

type Tiers = Record<string, unknown>;
type MoverKind = 'RIDER' | 'DRIVER';
type VendorKind = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

const OWNER = { courier: 8000, courierHeavy: 9000, taxi: 9000, service: 8000, small: 15000, large: 20000, department: 60000 };
const STANDARD_RIDER_VEHICLES: VehicleType[] = ['BICYCLE', 'MOTORCYCLE'];
const HEAVY_RIDER_VEHICLES: VehicleType[] = ['CANTER_SHORT', 'CANTER_LONG', 'BOX_TRUCK_SHORT', 'BOX_TRUCK_LONG'];
const TAXI_VEHICLES: VehicleType[] = ['CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15'];
const CATALOGUE_TYPES: VendorKind[] = ['RESTAURANT', 'SUPERMARKET', 'STORE'];

function seededTiers(code: string): Tiers {
  const country = desiredPlatformConfig().countries.find((c) => c.code === code);
  if (!country) throw new Error(`no seeded market ${code}`);
  return (country.policy as { subscriptionTiers: Tiers }).subscriptionTiers;
}

/** The error a pricing call raised, or undefined when it returned. */
function raised(fn: () => unknown): { code?: string } | undefined {
  try {
    fn();
  } catch (error) {
    return error as { code?: string };
  }
  return undefined;
}

// ── In-memory stand-ins for the three real consumers ───────────────────────

function countryConfigFake(tiersByCountry: Record<string, unknown>) {
  return {
    findUnique: vi.fn(async ({ where: { code } }: { where: { code: string } }) =>
      code in tiersByCountry
        ? {
            code,
            name: code,
            currencyCode: code === 'GY' ? 'GYD' : `${code}D`,
            currencySymbol: '$',
            isActive: true,
            subscriptionTiers: tiersByCountry[code],
          }
        : null,
    ),
  };
}

type SignupSubject =
  | { kind: MoverKind; vehicleType: VehicleType; riderType?: 'DELIVERY' | 'COURIER' | 'BOTH' }
  | { kind: 'VENDOR'; vendorType: VendorKind; ownedStores?: number };

/** Run the REAL SubscriptionService signup for one partner and return what it wrote. */
async function signup(subject: SignupSubject, tiers: Tiers, countryCode = 'GY') {
  const created: Array<Record<string, unknown>> = [];
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    created.push(data);
    return { id: `sub-${created.length}`, ...data };
  });
  const prisma = {
    countryConfig: countryConfigFake({ [countryCode]: tiers }),
    rider: {
      findUnique: vi.fn(async () =>
        subject.kind === 'RIDER'
          ? { riderType: subject.riderType ?? 'BOTH', vehicleType: subject.vehicleType, subscription: null, user: { countryCode } }
          : null,
      ),
      findUniqueOrThrow: vi.fn(async () => ({ userId: 'user-rider' })),
    },
    driver: {
      findUnique: vi.fn(async () =>
        subject.kind === 'DRIVER' ? { vehicleType: subject.vehicleType, subscription: null, user: { countryCode } } : null,
      ),
      findUniqueOrThrow: vi.fn(async () => ({ userId: 'user-driver' })),
    },
    vendor: {
      findUnique: vi.fn(async () =>
        subject.kind === 'VENDOR'
          ? {
              vendorType: subject.vendorType,
              subscription: null,
              owner: { user: { countryCode }, _count: { vendors: subject.ownedStores ?? 1 } },
            }
          : null,
      ),
      findUniqueOrThrow: vi.fn(async () => ({ owner: { userId: 'user-vendor' } })),
    },
    subscription: { create, findFirstOrThrow: vi.fn() },
    enforcementAction: { create: vi.fn(() => Promise.resolve({})) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ subscription: { create } })),
  } as unknown as PrismaClient;
  const service = new SubscriptionService(prisma);
  const run =
    subject.kind === 'RIDER'
      ? service.startTrialForRider('rider-1')
      : subject.kind === 'DRIVER'
        ? service.startTrialForDriver('driver-1')
        : service.startTrialForVendor('vendor-1');
  const outcome = await run.then(
    (sub) => ({ ok: true as const, sub }),
    (error: unknown) => ({ ok: false as const, error: error as { code?: string } }),
  );
  return { outcome, created, weeklyRate: created.length === 1 ? Number(created[0]!['weeklyRate']) : undefined };
}

interface MoverSubFixture {
  id: string;
  kind: MoverKind;
  vehicleType: VehicleType;
  weeklyRate: number;
  customRate?: number | null;
  feeWaived?: boolean;
  countryCode?: string;
}
interface VendorSubFixture {
  id: string;
  vendorType: VendorKind;
  activeItems: number;
  weeklyRate: number;
  ownedStores?: number;
  customRate?: number | null;
  feeWaived?: boolean;
  countryCode?: string;
}

/** Run the REAL BillingService weekly re-tier over the given subscriptions. */
async function retier(
  tiersByCountry: Record<string, unknown>,
  movers: MoverSubFixture[] = [],
  vendors: VendorSubFixture[] = [],
) {
  const updates = new Map<string, number>();
  const events: Array<Record<string, unknown>> = [];
  const moverRows = movers.map((m) => {
    const person = { vehicleType: m.vehicleType, user: { countryCode: m.countryCode ?? 'GY' } };
    return {
      id: m.id,
      riderId: m.kind === 'RIDER' ? `${m.id}-rider` : null,
      driverId: m.kind === 'DRIVER' ? `${m.id}-driver` : null,
      weeklyRate: m.weeklyRate,
      customRate: m.customRate ?? null,
      feeWaived: m.feeWaived ?? false,
      currencyCode: 'GYD',
      rider: m.kind === 'RIDER' ? person : null,
      driver: m.kind === 'DRIVER' ? person : null,
    };
  });
  const vendorRows = vendors.map((v) => ({
    id: v.id,
    vendorId: `${v.id}-vendor`,
    weeklyRate: v.weeklyRate,
    customRate: v.customRate ?? null,
    feeWaived: v.feeWaived ?? false,
    currencyCode: 'GYD',
    vendor: {
      id: `${v.id}-vendor`,
      vendorType: v.vendorType,
      owner: { user: { countryCode: v.countryCode ?? 'GY', id: `${v.id}-owner` }, _count: { vendors: v.ownedStores ?? 1 } },
    },
  }));
  const itemCounts = new Map(vendors.map((v) => [`${v.id}-vendor`, v.activeItems]));
  const prisma = {
    countryConfig: countryConfigFake(tiersByCountry),
    subscription: {
      findMany: vi.fn(async ({ where }: { where: { OR?: unknown } }) => (where.OR ? moverRows : vendorRows)),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: { weeklyRate: number } }) => {
        updates.set(id, Number(data.weeklyRate));
        return { id, ...data };
      }),
    },
    billingEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    item: {
      count: vi.fn(async ({ where }: { where: { vendorId: string; isAvailable: boolean } }) =>
        where.isAvailable === true ? (itemCounts.get(where.vendorId) ?? 0) : 0,
      ),
    },
  } as unknown as PrismaClient;
  const billing = new BillingService(prisma, {} as NotificationService, {} as PaymentProvider);
  const moversChanged = movers.length ? await billing.recalculateMoverTiers() : 0;
  const vendorsChanged = vendors.length ? await billing.recalculateVendorTiers() : 0;
  return { updates, events, moversChanged, vendorsChanged };
}

/** Serve the REAL public price list route with an in-memory CountryConfig table. */
async function pricingApp(tiersByCountry: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('prisma', { countryConfig: countryConfigFake(tiersByCountry) } as unknown as PrismaClient);
  app.decorate('authenticate', async () => undefined);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
  return app;
}

interface MoverQuoteBody {
  vehicleType: VehicleType;
  label: string;
  role: MoverKind;
  band: 'STANDARD' | 'HEAVY';
  tier: string;
  rate: number;
}
interface PriceListBody {
  countryCode: string;
  trialDays: number;
  movers?: MoverQuoteBody[];
  vendors?: { service: number; catalogue: Array<{ minItems: number; tier: string; rate: number }> };
  franchise: { minLocations: number; discountPct: number } | null;
  weekly?: Record<string, number | null>;
}

const apps: FastifyInstance[] = [];
async function priceList(tiersByCountry: Record<string, unknown>, country = 'GY') {
  const app = await pricingApp(tiersByCountry);
  apps.push(app);
  const res = await app.inject({ method: 'GET', url: `/api/v1/auth/pricing?country=${country}` });
  return { status: res.statusCode, body: res.json() as { data?: PriceListBody } };
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

// ── 1. The seeded Guyana rate card IS the owner rate card ──────────────────

describe('Guyana partner rate card — owner rates are the seeded config', () => {
  it('seeds every owner rate and keeps the 1,000 / 10,000 catalogue boundaries', () => {
    expect(seededTiers('GY')).toMatchObject({
      mover: OWNER.courier,
      moverHeavy: OWNER.courierHeavy,
      taxiDriver: OWNER.taxi,
      serviceVendor: OWNER.service,
      smallVendor: OWNER.small,
      largeVendor: OWNER.large,
      departmentVendor: OWNER.department,
      largeCatalogueThreshold: 1000,
      departmentCatalogueThreshold: 10000,
    });
  });

  it('a changed rate card is a new config version, never an in-place rewrite of an applied one', () => {
    // 2026-09-02.1 carried the previous card; 2026-09-23.1 is main's
    // Guyana-only launch config, which this card is layered on.
    for (const applied of ['2026-09-02.1', '2026-09-23.1']) expect(PLATFORM_CONFIG_VERSION).not.toBe(applied);
  });

  it('the three mover classes together are exactly the fleet, split by the passenger-vehicle rule provisioning uses', () => {
    const all = [...STANDARD_RIDER_VEHICLES, ...HEAVY_RIDER_VEHICLES, ...TAXI_VEHICLES].sort();
    expect(all).toEqual([...VEHICLE_TYPES_IN_ORDER].sort());
    for (const v of TAXI_VEHICLES) expect(VEHICLE_CLASSES[v].rideClass).not.toBeNull();
    for (const v of [...STANDARD_RIDER_VEHICLES, ...HEAVY_RIDER_VEHICLES]) expect(VEHICLE_CLASSES[v].rideClass).toBeNull();
    for (const v of STANDARD_RIDER_VEHICLES) expect(feeBandFor(v)).toBe('STANDARD');
    for (const v of HEAVY_RIDER_VEHICLES) expect(feeBandFor(v)).toBe('HEAVY');
  });
});

// ── 2. One resolver: role first, then vehicle band or catalogue size ───────

describe('partnerRateFor — one typed resolver for every partner', () => {
  const gy = () => seededTiers('GY') as pricing.SubscriptionTiers;

  it('separates taxi drivers from riders even on the same vehicle', () => {
    expect(pricing.partnerRateFor(gy(), { kind: 'DRIVER', vehicleType: 'CAR' })).toEqual({ rate: OWNER.taxi, tier: 'taxi', franchised: false });
    expect(pricing.partnerRateFor(gy(), { kind: 'RIDER', vehicleType: 'CAR' })).toEqual({ rate: OWNER.courier, tier: 'courier', franchised: false });
  });

  it('prices standard riders, heavy delivery and every taxi vehicle at the owner rates', () => {
    for (const vehicleType of STANDARD_RIDER_VEHICLES) {
      expect(pricing.partnerRateFor(gy(), { kind: 'RIDER', vehicleType })).toEqual({ rate: OWNER.courier, tier: 'courier', franchised: false });
    }
    for (const vehicleType of HEAVY_RIDER_VEHICLES) {
      expect(pricing.partnerRateFor(gy(), { kind: 'RIDER', vehicleType })).toEqual({ rate: OWNER.courierHeavy, tier: 'courierHeavy', franchised: false });
    }
    for (const vehicleType of TAXI_VEHICLES) {
      // A minibus driver is a taxi driver: the role decides, not the band.
      expect(pricing.partnerRateFor(gy(), { kind: 'DRIVER', vehicleType })).toEqual({ rate: OWNER.taxi, tier: 'taxi', franchised: false });
    }
  });

  it('prices services flat and catalogues by active items, the boundary itself qualifying', () => {
    const vendor = (isService: boolean, activeListings: number, ownedStores = 1) =>
      pricing.partnerRateFor(gy(), { kind: 'VENDOR', isService, activeListings, ownedStores });
    expect(vendor(true, 0)).toEqual({ rate: OWNER.service, tier: 'service', franchised: false });
    expect(vendor(true, 50000).rate).toBe(OWNER.service); // services never step up
    expect(vendor(false, 0)).toEqual({ rate: OWNER.small, tier: 'small', franchised: false });
    expect(vendor(false, 999).rate).toBe(OWNER.small);
    expect(vendor(false, 1000)).toEqual({ rate: OWNER.large, tier: 'large', franchised: false });
    expect(vendor(false, 9999).rate).toBe(OWNER.large);
    expect(vendor(false, 10000)).toEqual({ rate: OWNER.department, tier: 'department', franchised: false });
    expect(vendor(false, 250000).rate).toBe(OWNER.department);
    // The existing franchise rule still applies to each store's own tier.
    expect(vendor(false, 10, 5)).toEqual({ rate: OWNER.small / 2, tier: 'small', franchised: true });
  });

  it('a market without a taxi rate keeps pricing drivers by vehicle band, exactly as before', () => {
    const tt = seededTiers('TT') as pricing.SubscriptionTiers;
    expect(tt['taxiDriver']).toBeUndefined();
    expect(pricing.partnerRateFor(tt, { kind: 'DRIVER', vehicleType: 'CAR' }).rate).toBe(tt.mover);
    expect(pricing.partnerRateFor(tt, { kind: 'DRIVER', vehicleType: 'BUS_15' }).rate).toBe(tt.moverHeavy);
    expect(pricing.partnerRateFor(tt, { kind: 'RIDER', vehicleType: 'CANTER_LONG' }).rate).toBe(tt.moverHeavy);
    const noHeavy = { mover: 10000, smallVendor: 20000, largeVendor: 30000 } as pricing.SubscriptionTiers;
    expect(pricing.partnerRateFor(noHeavy, { kind: 'RIDER', vehicleType: 'BOX_TRUCK_LONG' }).rate).toBe(10000);
    expect(pricing.partnerRateFor(noHeavy, { kind: 'VENDOR', isService: true, activeListings: 0, ownedStores: 1 }).rate).toBe(20000);
  });
});

// ── 3. Unknown or broken config fails closed — never a silent zero ─────────

describe('an unpriceable partner is an error, never a free subscription', () => {
  const gy = () => seededTiers('GY');
  const rider = { kind: 'RIDER', vehicleType: 'MOTORCYCLE' } as const;
  const taxi = { kind: 'DRIVER', vehicleType: 'CAR' } as const;
  const shop = { kind: 'VENDOR', isService: false, activeListings: 0, ownedStores: 1 } as const;

  it.each([
    ['an empty tier map', {}, rider],
    ['a zero rider rate', { ...seededTiers('GY'), mover: 0 }, rider],
    ['an explicit zero taxi rate', { ...seededTiers('GY'), taxiDriver: 0 }, taxi],
    ['a negative heavy rate', { ...seededTiers('GY'), moverHeavy: -9000 }, { kind: 'RIDER', vehicleType: 'CANTER_LONG' }],
    ['a rate stored as text', { ...seededTiers('GY'), smallVendor: '15000' }, shop],
    ['a missing small-catalogue rate', { ...seededTiers('GY'), smallVendor: undefined }, shop],
    ['a zero service rate', { ...seededTiers('GY'), serviceVendor: 0 }, { ...shop, isService: true }],
    ['a 100% franchise "discount"', { ...seededTiers('GY'), franchiseDiscountPct: 100 }, { ...shop, ownedStores: 5 }],
    ['a negative franchise "discount"', { ...seededTiers('GY'), franchiseDiscountPct: -50 }, { ...shop, ownedStores: 5 }],
    ['a franchise threshold stored as text', { ...seededTiers('GY'), franchiseMinLocations: '5' }, shop],
    ['a department boundary at or below the large one', { ...seededTiers('GY'), departmentCatalogueThreshold: 1000 }, { ...shop, activeListings: 5000 }],
    ['a fractional catalogue boundary', { ...seededTiers('GY'), largeCatalogueThreshold: 999.5 }, shop],
  ] as Array<[string, Tiers, pricing.PartnerSubject]>)('%s', (_name, tiers, subject) => {
    expect(raised(() => pricing.partnerRateFor(tiers as pricing.SubscriptionTiers, subject))?.code).toBe('PRICING_CONFIG_INVALID');
  });

  it('a tier map that is not an object is refused', () => {
    expect(raised(() => pricing.partnerRateFor(null as unknown as pricing.SubscriptionTiers, rider))?.code).toBe('PRICING_CONFIG_INVALID');
  });

  it('signup refuses to write a subscription it cannot price', async () => {
    for (const [subject, tiers] of [
      [{ kind: 'RIDER', vehicleType: 'MOTORCYCLE' }, { ...gy(), mover: 0 }],
      [{ kind: 'DRIVER', vehicleType: 'CAR' }, { ...gy(), taxiDriver: 0 }],
      [{ kind: 'VENDOR', vendorType: 'SERVICE' }, { ...gy(), serviceVendor: 0 }],
      [{ kind: 'VENDOR', vendorType: 'RESTAURANT', ownedStores: 5 }, { ...gy(), franchiseDiscountPct: 100 }],
    ] as Array<[SignupSubject, Tiers]>) {
      const { outcome, created } = await signup(subject, tiers);
      expect(outcome.ok, JSON.stringify(subject)).toBe(false);
      expect(!outcome.ok && outcome.error.code).toBe('PRICING_CONFIG_INVALID');
      expect(created).toEqual([]);
    }
  });

  it('the re-tier holds an unpriceable subscription at its current rate and keeps going', async () => {
    const { updates, events, moversChanged } = await retier(
      { GY: gy(), ZZ: { mover: 0, smallVendor: 2000, largeVendor: 5000 } },
      [
        { id: 'broken', kind: 'RIDER', vehicleType: 'MOTORCYCLE', weeklyRate: 5000, countryCode: 'ZZ' },
        { id: 'healthy', kind: 'RIDER', vehicleType: 'MOTORCYCLE', weeklyRate: 10000 },
      ],
    );
    expect(updates.has('broken')).toBe(false);
    expect(events.some((e) => e['subscriptionId'] === 'broken')).toBe(false);
    expect(updates.get('healthy')).toBe(OWNER.courier);
    expect(moversChanged).toBe(1);
  });

  it('the public price list refuses to quote a market it cannot price', async () => {
    for (const broken of [{ ...gy(), mover: 0 }, { ...gy(), serviceVendor: '8000' }, { ...gy(), franchiseDiscountPct: 100 }]) {
      const { status, body } = await priceList({ GY: broken });
      expect(status, JSON.stringify(broken)).toBeGreaterThanOrEqual(500);
      expect(body.data).toBeUndefined();
    }
  });
});

// ── 4. Signup writes the owner rate ─────────────────────────────────────────

describe('signup — the rate a partner is born on', () => {
  it('standard riders 8,000 and heavy delivery 9,000, whatever work the rider does', async () => {
    for (const vehicleType of STANDARD_RIDER_VEHICLES) {
      for (const riderType of ['DELIVERY', 'COURIER', 'BOTH'] as const) {
        expect((await signup({ kind: 'RIDER', vehicleType, riderType }, seededTiers('GY'))).weeklyRate).toBe(OWNER.courier);
      }
    }
    for (const vehicleType of HEAVY_RIDER_VEHICLES) {
      expect((await signup({ kind: 'RIDER', vehicleType }, seededTiers('GY'))).weeklyRate).toBe(OWNER.courierHeavy);
    }
  });

  it('every taxi driver 9,000, car or bus', async () => {
    for (const vehicleType of TAXI_VEHICLES) {
      expect((await signup({ kind: 'DRIVER', vehicleType }, seededTiers('GY'))).weeklyRate).toBe(OWNER.taxi);
    }
  });

  it('services 8,000; a new restaurant, grocery or shop 15,000; the franchise rule unchanged', async () => {
    expect((await signup({ kind: 'VENDOR', vendorType: 'SERVICE' }, seededTiers('GY'))).weeklyRate).toBe(OWNER.service);
    for (const vendorType of CATALOGUE_TYPES) {
      expect((await signup({ kind: 'VENDOR', vendorType }, seededTiers('GY'))).weeklyRate).toBe(OWNER.small);
    }
    expect((await signup({ kind: 'VENDOR', vendorType: 'RESTAURANT', ownedStores: 5 }, seededTiers('GY'))).weeklyRate).toBe(OWNER.small / 2);
  });
});

// ── 5. The scheduled re-tier moves partners automatically ──────────────────

describe('weekly re-tier — automatic, no approval, custom and waived untouched', () => {
  it('moves every mover onto the owner rate for their role and vehicle', async () => {
    const { updates, events, moversChanged } = await retier({ GY: seededTiers('GY') }, [
      { id: 'bike', kind: 'RIDER', vehicleType: 'MOTORCYCLE', weeklyRate: 10000 },
      { id: 'canter', kind: 'RIDER', vehicleType: 'CANTER_LONG', weeklyRate: 12000 },
      { id: 'car', kind: 'DRIVER', vehicleType: 'CAR', weeklyRate: 10000 },
      { id: 'bus', kind: 'DRIVER', vehicleType: 'BUS_15', weeklyRate: 12000 },
      { id: 'wagon', kind: 'DRIVER', vehicleType: 'WAGON_CAR', weeklyRate: OWNER.taxi },
    ]);
    expect(Object.fromEntries(updates)).toEqual({ bike: OWNER.courier, canter: OWNER.courierHeavy, car: OWNER.taxi, bus: OWNER.taxi });
    expect(moversChanged).toBe(4);
    expect(events.map((e) => [e['subscriptionId'], e['type'], Number(e['amount'])])).toEqual([
      ['bike', 'TIER_CHANGE', OWNER.courier],
      ['canter', 'TIER_CHANGE', OWNER.courierHeavy],
      ['car', 'TIER_CHANGE', OWNER.taxi],
      ['bus', 'TIER_CHANGE', OWNER.taxi],
    ]);
  });

  it('a rider who buys a canter moves to heavy delivery; a taxi driver who buys a bus stays on the taxi rate', async () => {
    const { updates } = await retier({ GY: seededTiers('GY') }, [
      { id: 'upgraded-rider', kind: 'RIDER', vehicleType: 'BOX_TRUCK_SHORT', weeklyRate: OWNER.courier },
      { id: 'upgraded-driver', kind: 'DRIVER', vehicleType: 'BUS_9', weeklyRate: OWNER.taxi },
    ]);
    expect(Object.fromEntries(updates)).toEqual({ 'upgraded-rider': OWNER.courierHeavy });
  });

  it('moves every store across the catalogue boundaries, up and down', async () => {
    const { updates, vendorsChanged } = await retier({ GY: seededTiers('GY') }, [], [
      { id: 'r999', vendorType: 'RESTAURANT', activeItems: 999, weeklyRate: 20000 },
      { id: 's1000', vendorType: 'STORE', activeItems: 1000, weeklyRate: OWNER.small },
      { id: 'g9999', vendorType: 'SUPERMARKET', activeItems: 9999, weeklyRate: 30000 },
      { id: 'g10000', vendorType: 'SUPERMARKET', activeItems: 10000, weeklyRate: 50000 },
      { id: 'svc', vendorType: 'SERVICE', activeItems: 40, weeklyRate: 12000 },
      { id: 'steady', vendorType: 'STORE', activeItems: 12, weeklyRate: OWNER.small },
    ]);
    expect(Object.fromEntries(updates)).toEqual({ r999: OWNER.small, s1000: OWNER.large, g9999: OWNER.large, g10000: OWNER.department, svc: OWNER.service });
    expect(vendorsChanged).toBe(5);
  });

  it('never overwrites a negotiated rate or a waived fee, on any path', async () => {
    const { updates, events } = await retier(
      { GY: seededTiers('GY') },
      [
        { id: 'custom-rider', kind: 'RIDER', vehicleType: 'CANTER_LONG', weeklyRate: 7000, customRate: 7000 },
        { id: 'custom-driver', kind: 'DRIVER', vehicleType: 'BUS_15', weeklyRate: 12000, customRate: 6500 },
        { id: 'waived-driver', kind: 'DRIVER', vehicleType: 'CAR', weeklyRate: 10000, feeWaived: true },
        { id: 'waived-rider', kind: 'RIDER', vehicleType: 'BICYCLE', weeklyRate: 10000, feeWaived: true },
      ],
      [
        { id: 'custom-dept', vendorType: 'SUPERMARKET', activeItems: 50000, weeklyRate: 20000, customRate: 12345 },
        { id: 'waived-large', vendorType: 'STORE', activeItems: 1000, weeklyRate: 20000, feeWaived: true },
        { id: 'custom-service', vendorType: 'SERVICE', activeItems: 0, weeklyRate: 12000, customRate: 0 },
      ],
    );
    expect(updates.size).toBe(0);
    expect(events).toEqual([]);
  });
});

// ── 6. The public price list IS the bill ───────────────────────────────────

describe('public price list — quote equals bill, for every partner', () => {
  it('quotes every vehicle with the role it provisions, and every vendor tier, at the owner rates', async () => {
    const { status, body } = await priceList({ GY: seededTiers('GY') });
    expect(status).toBe(200);
    const d = body.data!;
    expect(d.movers?.map((q) => q.vehicleType)).toEqual(VEHICLE_TYPES_IN_ORDER);
    const byVehicle = new Map(d.movers!.map((q) => [q.vehicleType, q]));
    for (const v of STANDARD_RIDER_VEHICLES) expect(byVehicle.get(v)).toMatchObject({ role: 'RIDER', band: 'STANDARD', tier: 'courier', rate: OWNER.courier });
    for (const v of HEAVY_RIDER_VEHICLES) expect(byVehicle.get(v)).toMatchObject({ role: 'RIDER', band: 'HEAVY', tier: 'courierHeavy', rate: OWNER.courierHeavy });
    for (const v of TAXI_VEHICLES) expect(byVehicle.get(v)).toMatchObject({ role: 'DRIVER', tier: 'taxi', rate: OWNER.taxi });
    for (const q of d.movers!) expect(q.label).toBe(VEHICLE_CLASSES[q.vehicleType].label);
    expect(d.vendors).toEqual({
      service: OWNER.service,
      catalogue: [
        { minItems: 0, tier: 'small', rate: OWNER.small },
        { minItems: 1000, tier: 'large', rate: OWNER.large },
        { minItems: 10000, tier: 'department', rate: OWNER.department },
      ],
    });
    expect(d.franchise).toEqual({ minLocations: 5, discountPct: 50 });
  });

  it('each vehicle quote is what signup writes and what the re-tier bills for that partner', async () => {
    const tiers = seededTiers('GY');
    const { body } = await priceList({ GY: tiers });
    for (const quote of body.data!.movers!) {
      const born = await signup({ kind: quote.role, vehicleType: quote.vehicleType }, tiers);
      expect(born.weeklyRate, `${quote.vehicleType} signup`).toBe(quote.rate);
      const { updates } = await retier({ GY: tiers }, [{ id: 'stale', kind: quote.role, vehicleType: quote.vehicleType, weeklyRate: 1 }]);
      expect(updates.get('stale'), `${quote.vehicleType} re-tier`).toBe(quote.rate);
    }
  });

  it('each vendor quote is what signup writes and what the re-tier bills, on both sides of every boundary', async () => {
    const tiers = seededTiers('GY');
    const { body } = await priceList({ GY: tiers });
    const { service, catalogue } = body.data!.vendors!;
    expect((await signup({ kind: 'VENDOR', vendorType: 'SERVICE' }, tiers)).weeklyRate).toBe(service);
    for (const vendorType of CATALOGUE_TYPES) {
      expect((await signup({ kind: 'VENDOR', vendorType }, tiers)).weeklyRate).toBe(catalogue[0]!.rate);
    }
    const counts: Array<[number, number]> = [];
    catalogue.forEach((band, i) => {
      counts.push([band.minItems, band.rate]);
      const next = catalogue[i + 1];
      if (next) counts.push([next.minItems - 1, band.rate]);
    });
    counts.push([catalogue[catalogue.length - 1]!.minItems * 5, catalogue[catalogue.length - 1]!.rate]);
    for (const [activeItems, rate] of counts) {
      const { updates } = await retier({ GY: tiers }, [], [{ id: 'stale', vendorType: 'STORE', activeItems, weeklyRate: 1 }]);
      expect(updates.get('stale'), `${activeItems} active items`).toBe(rate);
    }
    const { updates } = await retier({ GY: tiers }, [], [{ id: 'svc', vendorType: 'SERVICE', activeItems: 20000, weeklyRate: 1 }]);
    expect(updates.get('svc')).toBe(service);
  });

  it('every quoted role is the entity provisioning creates for that vehicle', async () => {
    const { body } = await priceList({ GY: seededTiers('GY') });
    for (const quote of body.data!.movers!) {
      const tx = {
        $queryRaw: vi.fn(async () => [{ id: 'user-1', roles: ['CUSTOMER'] }]),
        rider: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'rider-1' })) },
        driver: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'driver-1' })) },
        user: { update: vi.fn(async () => ({})) },
      };
      const partners = new PartnerService({} as PrismaClient) as unknown as {
        provisionLocked(tx: unknown, userId: string, input: unknown): Promise<{ kind: string }>;
      };
      const provisioned = await partners.provisionLocked(tx, 'user-1', {
        role: 'MOVER',
        vehicleType: quote.vehicleType,
        vehicle: { make: 'Toyota', model: 'Hiace', year: 2022, color: 'White', licensePlate: 'PPR-1' },
      });
      expect(provisioned.kind, quote.vehicleType).toBe(quote.role);
    }
  });

  it('keeps nonzero legacy fields for older clients that never under-quote the partners who read them', async () => {
    const { body } = await priceList({ GY: seededTiers('GY') });
    const d = body.data!;
    expect(d.weekly).toEqual({
      mover: OWNER.taxi,
      moverHeavy: OWNER.courierHeavy,
      serviceVendor: OWNER.service,
      smallVendor: OWNER.small,
      largeVendor: OWNER.large,
      departmentVendor: OWNER.department,
    });
    // An older web page shows `mover` to every standard-vehicle mover and
    // `moverHeavy` to every heavy one: neither may ever read below a bill.
    for (const q of d.movers!) {
      const legacy = q.band === 'HEAVY' ? d.weekly!['moverHeavy'] : d.weekly!['mover'];
      expect(legacy!, q.vehicleType).toBeGreaterThanOrEqual(q.rate);
    }
    // An older app's onboarding card shows `mover` to every mover and
    // `smallVendor` to every business, whatever the vehicle or trade.
    expect(d.weekly!['mover']).toBeGreaterThanOrEqual(Math.max(...d.movers!.map((q) => q.rate)));
    expect(d.weekly!['smallVendor']).toBeGreaterThanOrEqual(d.vendors!.service);
  });

  it('a market that has not adopted the taxi rate reports exactly the legacy numbers it always did', () => {
    // Priced directly: the public route serves launch markets only.
    const d = partnerPriceList(seededTiers('TT'));
    expect(d.weekly).toEqual({ mover: 320, moverHeavy: 390, serviceVendor: 390, smallVendor: 650, largeVendor: 970, departmentVendor: 1600 });
    const byVehicle = new Map(d.movers.map((q) => [q.vehicleType, q.rate]));
    expect([byVehicle.get('CAR'), byVehicle.get('BUS_15'), byVehicle.get('MOTORCYCLE'), byVehicle.get('CANTER_LONG')]).toEqual([320, 390, 320, 390]);
  });

  it('404s an unknown market', async () => {
    expect((await priceList({ GY: seededTiers('GY') }, 'ZZ')).status).toBe(404);
  });
});

// ── 7. Scope: Guyana only ───────────────────────────────────────────────────

describe('scope — the Guyana re-price leaves every pegged market exactly as it was', () => {
  const BEFORE: Record<string, Record<string, number>> = {
    TT: { mover: 320, moverHeavy: 390, serviceVendor: 390, smallVendor: 650, largeVendor: 970, departmentVendor: 1600 },
    JM: { mover: 7600, moverHeavy: 9100, serviceVendor: 9100, smallVendor: 15100, largeVendor: 22700, departmentVendor: 37800 },
    BB: { mover: 96, moverHeavy: 110, serviceVendor: 110, smallVendor: 190, largeVendor: 290, departmentVendor: 480 },
    BS: { mover: 48, moverHeavy: 57, serviceVendor: 57, smallVendor: 96, largeVendor: 140, departmentVendor: 240 },
    SR: { mover: 1800, moverHeavy: 2200, serviceVendor: 2200, smallVendor: 3600, largeVendor: 5500, departmentVendor: 9100 },
    BZ: { mover: 96, moverHeavy: 110, serviceVendor: 110, smallVendor: 190, largeVendor: 290, departmentVendor: 480 },
    GD: { mover: 130, moverHeavy: 160, serviceVendor: 160, smallVendor: 260, largeVendor: 390, departmentVendor: 650 },
    LC: { mover: 130, moverHeavy: 160, serviceVendor: 160, smallVendor: 260, largeVendor: 390, departmentVendor: 650 },
    AG: { mover: 130, moverHeavy: 160, serviceVendor: 160, smallVendor: 260, largeVendor: 390, departmentVendor: 650 },
    VC: { mover: 130, moverHeavy: 160, serviceVendor: 160, smallVendor: 260, largeVendor: 390, departmentVendor: 650 },
    KN: { mover: 130, moverHeavy: 160, serviceVendor: 160, smallVendor: 260, largeVendor: 390, departmentVendor: 650 },
    DM: { mover: 130, moverHeavy: 160, serviceVendor: 160, smallVendor: 260, largeVendor: 390, departmentVendor: 650 },
  };
  const RULES = { largeCatalogueThreshold: 1000, departmentCatalogueThreshold: 10000, franchiseMinLocations: 5, franchiseDiscountPct: 50 };

  it.each(Object.keys(BEFORE))('%s keeps its tiers byte-for-byte', (code) => {
    expect(seededTiers(code)).toEqual({ ...BEFORE[code], ...RULES });
  });

  it('the dev seed prices its demo taxi drivers at the taxi rate, not the rider rate', () => {
    const seed = readFileSync(join(__dirname, '..', '..', 'prisma', 'seed.ts'), 'utf8');
    expect(seed).toContain("type: 'TAXI_DRIVER'");
    expect(seed).not.toMatch(/weeklyRate:\s*guyanaTiers\.mover\b/);
    expect(seed).toMatch(/weeklyRate:\s*guyanaTiers\.taxiDriver\b/);
  });
});
