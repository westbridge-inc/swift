import type { PrismaClient, RideClass } from '@prisma/client';
import { getMapsProvider, type MapsProvider, type RouteSource } from '../../providers/maps/maps-provider';
import { canonicalBillableKm } from '../../utils/billable-distance';
import { type GeoPoint } from '../../utils/geo';
import { resolveFareZones, DEFAULT_TENANT_ID } from './fare-zones';
import { CountryConfigService } from '../country/country-config.service';
import { readTaxiRates, readClassRates, assertSaneFare } from '../country/pricing-config';

// ---------------------------------------------------------------------------
// Fare engine — deterministic, computed and shown BEFORE
// any driver sees the request. Zone-to-zone table wins; gaps fall back to
// the CountryConfig formula. Never an AI call, never a post-hoc surprise.
// ---------------------------------------------------------------------------

// [M-35] The rates and their defaults live with the pricing-config law: one
// strict schema per kind, validated at write and at read, versioned, in
// declared units. The fare engine never reads raw JSON again.
export type { TaxiRates, ClassRates } from '../country/pricing-config';
export { DEFAULT_CLASS_RATES } from '../country/pricing-config';
const AVG_SPEED_KMH = 25;

// --- Ride tiers (deterministic, never AI — hard rule 1) --------------------

/** Seat capacity per tier — a code rule, not stored on the driver. GROUP covers
 *  up to a 15-seater minibus (14 passengers + driver). */
export const CLASS_CAPACITY: Record<RideClass, number> = { ECONOMY: 4, COMFORT: 4, XL: 6, GROUP: 14 };

/** Tiers cheapest → priciest. Index also encodes "serves all classes <= it". */
export const RIDE_CLASS_ORDER: RideClass[] = ['ECONOMY', 'COMFORT', 'XL', 'GROUP'];

/**
 * Driver classes eligible for an order of `orderClass`. A driver's rideClass is
 * the TOP tier their vehicle serves, so an order is served by any driver whose
 * class is at or above it (an XL request never offers to a 4-seat Economy car).
 */
export function classesAtOrAbove(orderClass: RideClass): RideClass[] {
  const i = RIDE_CLASS_ORDER.indexOf(orderClass);
  return i < 0 ? [...RIDE_CLASS_ORDER] : RIDE_CLASS_ORDER.slice(i);
}

/**
 * The ride classes a driver of `driverClass` can serve — their own tier and every
 * tier below it [SWIFT-063]. The inverse of classesAtOrAbove: an Economy driver
 * serves only Economy, an XL driver serves everything. Used to gate the driver's
 * board + accept path so the cascade isn't the ONLY place ride class is enforced.
 */
export function classesAtOrBelow(driverClass: RideClass): RideClass[] {
  const i = RIDE_CLASS_ORDER.indexOf(driverClass);
  return i < 0 ? [...RIDE_CLASS_ORDER] : RIDE_CLASS_ORDER.slice(0, i + 1);
}

/**
 * Apply a tier multiplier to the base (Economy) fare. Economy (×1.0) is returned
 * unchanged so existing fares never move. Other tiers scale the fare and the
 * per-class minimum, with the same cash-friendly 100-unit rounding as the formula.
 */
export function applyClassMultiplier(baseFare: number, multiplier: number, baseMinimum: number): number {
  if (multiplier === 1) return baseFare;
  const scaled = Math.round((baseFare * multiplier) / 100) * 100;
  const scaledMin = Math.round((baseMinimum * multiplier) / 100) * 100;
  return Math.max(scaledMin, scaled);
}

export interface TierEstimate {
  rideClass: RideClass;
  fare: number;
  multiplier: number;
  capacity: number;
  source: 'zone_table' | 'formula';
}

export interface TieredEstimate {
  tiers: TierEstimate[];
  currencyCode: string;
  distanceKm: number;
  durationMin: number;
  /** [ALG-18] The canonical kilometres the fare was priced from — frozen on the order. */
  billableKm: number;
  /** [ALG-18] The engine that produced it. */
  routeSource: RouteSource;
}

export interface FareEstimate {
  fare: number;
  currencyCode: string;
  distanceKm: number;
  durationMin: number;
  source: 'zone_table' | 'formula';
  /** [ALG-18] The canonical kilometres the fare was priced from — frozen on the order. */
  billableKm: number;
  /** [ALG-18] The engine that produced it. */
  routeSource: RouteSource;
  fromZoneId?: string;
  toZoneId?: string;
  /** [M-34] The zone versions the fare was priced against, when the table priced it. */
  fromZoneVersion?: number;
  toZoneVersion?: number;
}

export class FareService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private maps: MapsProvider = getMapsProvider(),
  ) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  async estimate(pickup: GeoPoint, dropoff: GeoPoint, countryCode: string, tenantId: string = DEFAULT_TENANT_ID): Promise<FareEstimate> {
    // Real road route when a routing engine (OSRM) is configured; the
    // deterministic estimate otherwise — identical to the historical numbers.
    const route = await this.maps.routeKm(pickup, dropoff);
    // [ALG-18] Canonical BEFORE pricing: the fare and the frozen number are one number.
    const distanceKm = canonicalBillableKm(route.km);
    const durationMin = Math.ceil(route.minutes ?? (distanceKm / AVG_SPEED_KMH) * 60);

    const config = await this.countryConfig.getByCode(countryCode);
    // [M-35] Validated, versioned rates — or the last known good, never raw JSON.
    const rates = (await readTaxiRates(this.prisma, countryCode)).payload;

    // Zone table first — both ends must resolve. [M-34] Only THIS tenant's
    // active zones in THIS country are candidates, with deterministic
    // precedence (priority, then the smallest polygon, then the id); the
    // legacy first-match pick is shadowed and every disagreement counted.
    const resolved = await resolveFareZones(this.prisma, { tenantId, countryCode }, pickup, dropoff);
    const fromZone = resolved.from.zone;
    const toZone = resolved.to.zone;

    if (fromZone && toZone) {
      const zoneFare = await this.prisma.zoneFare.findUnique({
        where: { fromZoneId_toZoneId: { fromZoneId: fromZone.id, toZoneId: toZone.id } },
      });
      if (zoneFare) {
        return {
          fare: assertSaneFare(Number(zoneFare.fare), 'zone_table'),
          currencyCode: config.currencyCode,
          distanceKm: round1(distanceKm),
          billableKm: distanceKm,
          routeSource: route.source,
          durationMin,
          source: 'zone_table',
          fromZoneId: fromZone.id,
          toZoneId: toZone.id,
          fromZoneVersion: fromZone.version,
          toZoneVersion: toZone.version,
        };
      }
    }

    // Formula fallback — validated rates, cash-friendly rounding
    const raw = rates.base + rates.perKm * distanceKm + rates.perMin * durationMin;
    const fare = assertSaneFare(Math.max(rates.minimum, Math.round(raw / 100) * 100), 'formula');

    return {
      fare,
      currencyCode: config.currencyCode,
      distanceKm: round1(distanceKm),
      billableKm: distanceKm,
      routeSource: route.source,
      durationMin,
      source: 'formula',
      fromZoneId: fromZone?.id,
      toZoneId: toZone?.id,
    };
  }

  /**
   * Tiered fares (Economy/Comfort/XL) for the request screen — the base fare
   * once, then each tier = base × class multiplier (Economy unchanged). All
   * deterministic; shown before any driver sees the request.
   */
  async estimateTiers(pickup: GeoPoint, dropoff: GeoPoint, countryCode: string, tenantId: string = DEFAULT_TENANT_ID): Promise<TieredEstimate> {
    const base = await this.estimate(pickup, dropoff, countryCode, tenantId);
    // [M-35] Validated, versioned rates and multipliers (Economy is exactly 1 by schema).
    const rates = (await readTaxiRates(this.prisma, countryCode)).payload;
    const classRates = (await readClassRates(this.prisma, countryCode)).payload;

    const tiers: TierEstimate[] = RIDE_CLASS_ORDER.map((rideClass) => {
      const multiplier = classRates[rideClass];
      return {
        rideClass,
        multiplier,
        fare: assertSaneFare(applyClassMultiplier(base.fare, multiplier, rates.minimum), `tier_${rideClass}`),
        capacity: CLASS_CAPACITY[rideClass],
        source: base.source,
      };
    });

    return { tiers, currencyCode: base.currencyCode, distanceKm: base.distanceKm, durationMin: base.durationMin, billableKm: base.billableKm, routeSource: base.routeSource };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
