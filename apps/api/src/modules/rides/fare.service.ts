import type { PrismaClient, RideClass } from '@prisma/client';
import { isRideClassServed } from '../../config/vehicle-classes';
import { assertRoadQuoteAvailable, getMapsProvider, type MapsProvider, type RouteLegsEstimate, type RouteSource } from '../../providers/maps/maps-provider';
import { canonicalBillableKm } from '../../utils/billable-distance';
import { AppError } from '../../utils/errors';
import { type GeoPoint } from '../../utils/geo';
import { resolveFareZonePath, resolveFareZones, zonePricedPairs, zoneTaxiPerKm, DEFAULT_TENANT_ID } from './fare-zones';
import { assertTaxiRouteInMarket, placeCode } from './taxi-itinerary';
import { CountryConfigService } from '../country/country-config.service';
import { readTaxiRates, readClassRates, assertSaneFare, type TaxiRates, type ClassRates } from '../country/pricing-config';

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
 * The tiers a customer is OFFERED: the ordered ladder, minus any class no vehicle
 * in the fleet serves (`SERVED_RIDE_CLASSES`, config/vehicle-classes.ts). Today
 * that hides XL. The eligibility ladder below keeps every class — a GROUP driver
 * still serves an XL request in the abstract — so nothing else moves when a
 * vehicle class is mapped to XL later.
 */
export function offeredRideClasses(): RideClass[] {
  return RIDE_CLASS_ORDER.filter((c) => isRideClassServed(c));
}

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

/**
 * The country formula, applied ONCE to ONE trip: the base, the kilometres it
 * includes and the minimum once, the trip's billable kilometres and minutes,
 * one cash-friendly rounding to 100. A ride with stops is one trip over its
 * whole route: it comes here once, never once per leg — no fee per stop,
 * none for waiting. With no included kilometres (0, or unnamed) the formula
 * is exactly what it was before they existed.
 */
export function formulaFare(rates: TaxiRates, billableKm: number, durationMin: number): number {
  const raw = rates.base + rates.perKm * Math.max(0, billableKm - (rates.includedKm ?? 0)) + rates.perMin * durationMin;
  return assertSaneFare(Math.max(rates.minimum, Math.round(raw / 100) * 100), 'formula');
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

/** [TAXI multi-stop] One leg of a priced itinerary, for the passenger to read
 *  and for the stop rows (legMeters / legSeconds). Never money: the fare is
 *  priced from the whole route. */
export interface ItineraryLeg {
  /** PICKUP, STOP_1..STOP_3 or DESTINATION (the itinerary place codes). */
  from: string;
  to: string;
  /** Whole metres. */
  meters: number;
  /** Whole seconds; null when the engine gave no duration (the estimate). */
  seconds: number | null;
}

export interface ItineraryEstimate extends TieredEstimate {
  legs: ItineraryLeg[];
}

/** [TAXI multi-stop] A route a fare may be priced from: not degraded, one leg
 *  per pair of points, every leg a finite distance of 0 m or more (one leg of
 *  0 m is real: two points across one road snap to one node), and a whole
 *  route longer than 0 km. A route of 0 km routed nothing, and is refused
 *  rather than priced at the minimum. [DS282 F2] */
function isPriceableRoute(route: RouteLegsEstimate, legCount: number): boolean {
  const distance = (v: number) => Number.isFinite(v) && v >= 0;
  const minutes = (v: number | null) => v == null || distance(v);
  return !route.degraded
    && route.legs.length === legCount
    && route.legs.every((leg) => distance(leg.km) && minutes(leg.minutes))
    && distance(route.km) && route.km > 0
    && minutes(route.minutes);
}

/** Each offered tier from ONE base (Economy) fare. */
function tierFares(baseFare: number, source: TierEstimate['source'], baseMinimum: number, classRates: ClassRates): TierEstimate[] {
  return offeredRideClasses().map((rideClass) => {
    const multiplier = classRates[rideClass];
    return {
      rideClass,
      multiplier,
      fare: assertSaneFare(applyClassMultiplier(baseFare, multiplier, baseMinimum), `tier_${rideClass}`),
      capacity: CLASS_CAPACITY[rideClass],
      source,
    };
  });
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
    assertRoadQuoteAvailable(route);
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

    // Formula fallback — validated rates, cash-friendly rounding. [ZONE-FARES]
    // A zone at either end may set its own per-km rate (the higher of the two).
    const fare = formulaFare(ratesForTrip(rates, zoneTaxiPerKm(resolved.from, resolved.to)), distanceKm, durationMin);

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

    const tiers = tierFares(base.fare, base.source, rates.minimum, classRates);

    return { tiers, currencyCode: base.currencyCode, distanceKm: base.distanceKm, durationMin: base.durationMin, billableKm: base.billableKm, routeSource: base.routeSource };
  }

  /**
   * [TAXI multi-stop] Tiered fares for a ride with intermediate stops: the
   * WHOLE route, pickup → stops in order → destination, routed in one call and
   * priced as one trip — its kilometres rounded once, its minutes once, the
   * base and the minimum once, no fee per stop and none for waiting (AF.16) —
   * then the same tiers as any ride. A ride without stops never comes here:
   * estimateTiers prices it, exactly as before.
   *
   * Refuses rather than guesses:
   *  - 400 STOP_OUT_OF_MARKET when a point of the route lies outside the
   *    launch market (an engine snaps it to a road it knows and prices the
   *    wrong place);
   *  - 409 MULTI_STOP_ZONE_PRICED when the zone table prices any leg, or the
   *    direct pickup → destination pair (v1; FARE_ZONE_TABLE_KILL=1 bypasses
   *    the table here as everywhere);
   *  - 503 ROUTE_UNAVAILABLE when the configured routing engine could not
   *    route it (ALG-11), or routed nothing (a route of 0 km): a single-leg
   *    ride keeps its fallback, a ride with stops is never priced from a guess.
   */
  async estimateItineraryTiers(pickup: GeoPoint, stops: readonly GeoPoint[], dropoff: GeoPoint, countryCode: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ItineraryEstimate> {
    if (stops.length === 0) {
      throw new Error('estimateItineraryTiers prices a ride with stops; a ride without stops is priced by estimateTiers');
    }
    assertTaxiRouteInMarket({ pickup, stops, dropoff });
    const points: GeoPoint[] = [pickup, ...stops.map((s) => ({ lat: s.lat, lng: s.lng })), dropoff];

    // [M-34] The requester's market's zones, every leg and the direct pair.
    // [ZONE-FARES] Resolved once: the same picks name the ends' per-km below.
    const path = await resolveFareZonePath(this.prisma, { tenantId, countryCode }, points);
    const [zonePriced] = await zonePricedPairs(this.prisma, { tenantId, countryCode }, points, path);
    if (zonePriced) {
      throw new AppError(409, 'MULTI_STOP_ZONE_PRICED',
        'This trip has a fixed zone fare, so stops cannot be added to it yet. Remove the stops to book it at the fixed fare.',
        {
          from: placeCode(zonePriced.from, stops.length),
          to: placeCode(zonePriced.to, stops.length),
          fromZoneId: zonePriced.fromZoneId,
          toZoneId: zonePriced.toZoneId,
        });
    }

    const route = await this.maps.routeLegs(points);
    if (!isPriceableRoute(route, points.length - 1)) {
      throw new AppError(503, 'ROUTE_UNAVAILABLE',
        'We cannot route a trip with stops right now. Try again in a moment, or remove the stops.',
        { stopCount: stops.length });
    }
    // [ALG-18] The whole route, rounded ONCE: the fare and the frozen number are one number.
    const billableKm = canonicalBillableKm(route.km);
    const durationMin = Math.ceil(route.minutes ?? (billableKm / AVG_SPEED_KMH) * 60);

    const config = await this.countryConfig.getByCode(countryCode);
    // [M-35] Validated, versioned rates and multipliers.
    const rates = (await readTaxiRates(this.prisma, countryCode)).payload;
    const classRates = (await readClassRates(this.prisma, countryCode)).payload;

    // [ZONE-FARES] The pickup's and the destination's zones set the per-km, as
    // for a ride without stops; a stop on the way never does.
    const perKm = zoneTaxiPerKm(path.picks[0]!, path.picks[points.length - 1]!);

    return {
      tiers: tierFares(formulaFare(ratesForTrip(rates, perKm), billableKm, durationMin), 'formula', rates.minimum, classRates),
      currencyCode: config.currencyCode,
      distanceKm: round1(billableKm),
      durationMin,
      billableKm,
      routeSource: route.source,
      legs: route.legs.map((leg, i) => ({
        from: placeCode(i, stops.length),
        to: placeCode(i + 1, stops.length),
        meters: Math.round(leg.km * 1000),
        seconds: leg.minutes == null ? null : Math.round(leg.minutes * 60),
      })),
    };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * [ZONE-FARES] The market's rates with the per-km rate a trip's ends set (see
 * fare-zones `zoneTaxiPerKm`) in place of the market's own, or the market's
 * rates unchanged when neither end sets one. Only the per-km moves: the base,
 * the included kilometres, the per-minute and the minimum stay the market's.
 */
export function ratesForTrip(rates: TaxiRates, zonePerKm: number | null): TaxiRates {
  return zonePerKm === null ? rates : { ...rates, perKm: zonePerKm };
}
