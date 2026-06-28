import type { PrismaClient, RideClass } from '@prisma/client';
import { estimateDrivingDistance } from '../../utils/distance';
import { pointInPolygon, type GeoPoint } from '../../utils/geo';
import { CountryConfigService } from '../country/country-config.service';

// ---------------------------------------------------------------------------
// Fare engine — deterministic, computed and shown BEFORE
// any driver sees the request. Zone-to-zone table wins; gaps fall back to
// the CountryConfig formula. Never an AI call, never a post-hoc surprise.
// ---------------------------------------------------------------------------

export interface TaxiRates {
  base: number;
  perKm: number;
  perMin: number;
  minimum: number;
}

const DEFAULT_RATES: TaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };
const AVG_SPEED_KMH = 25;

// --- Ride tiers (deterministic, never AI — hard rule 1) --------------------

export type ClassRates = Record<RideClass, number>;

/** Multipliers on the base (Economy) fare. Code default when CountryConfig is null. */
export const DEFAULT_CLASS_RATES: ClassRates = { ECONOMY: 1.0, COMFORT: 1.35, XL: 1.8 };

/** Seat capacity per tier — a code rule, not stored on the driver. */
export const CLASS_CAPACITY: Record<RideClass, number> = { ECONOMY: 4, COMFORT: 4, XL: 6 };

/** Tiers cheapest → priciest. Index also encodes "serves all classes <= it". */
export const RIDE_CLASS_ORDER: RideClass[] = ['ECONOMY', 'COMFORT', 'XL'];

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
}

export interface FareEstimate {
  fare: number;
  currencyCode: string;
  distanceKm: number;
  durationMin: number;
  source: 'zone_table' | 'formula';
  fromZoneId?: string;
  toZoneId?: string;
}

export class FareService {
  private countryConfig: CountryConfigService;

  constructor(private prisma: PrismaClient) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  async estimate(pickup: GeoPoint, dropoff: GeoPoint, countryCode: string): Promise<FareEstimate> {
    const distanceKm = estimateDrivingDistance(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    const durationMin = Math.ceil((distanceKm / AVG_SPEED_KMH) * 60);

    const config = await this.countryConfig.getByCode(countryCode);

    // Zone table first — both ends must resolve
    const zones = await this.prisma.zone.findMany({ where: { isActive: true } });
    const fromZone = zones.find((z) => pointInPolygon(pickup, z.boundary));
    const toZone = zones.find((z) => pointInPolygon(dropoff, z.boundary));

    if (fromZone && toZone) {
      const zoneFare = await this.prisma.zoneFare.findUnique({
        where: { fromZoneId_toZoneId: { fromZoneId: fromZone.id, toZoneId: toZone.id } },
      });
      if (zoneFare) {
        return {
          fare: Number(zoneFare.fare),
          currencyCode: config.currencyCode,
          distanceKm: round1(distanceKm),
          durationMin,
          source: 'zone_table',
          fromZoneId: fromZone.id,
          toZoneId: toZone.id,
        };
      }
    }

    // Formula fallback — rates from config, cash-friendly rounding
    const rates = { ...DEFAULT_RATES, ...((config.taxiRates as Partial<TaxiRates> | null) ?? {}) };
    const raw = rates.base + rates.perKm * distanceKm + rates.perMin * durationMin;
    const fare = Math.max(rates.minimum, Math.round(raw / 100) * 100);

    return {
      fare,
      currencyCode: config.currencyCode,
      distanceKm: round1(distanceKm),
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
  async estimateTiers(pickup: GeoPoint, dropoff: GeoPoint, countryCode: string): Promise<TieredEstimate> {
    const base = await this.estimate(pickup, dropoff, countryCode);
    const config = await this.countryConfig.getByCode(countryCode);
    const rates = { ...DEFAULT_RATES, ...((config.taxiRates as Partial<TaxiRates> | null) ?? {}) };
    const classRates: ClassRates = {
      ...DEFAULT_CLASS_RATES,
      ...((config.taxiClassRates as Partial<ClassRates> | null) ?? {}),
    };

    const tiers: TierEstimate[] = RIDE_CLASS_ORDER.map((rideClass) => {
      const multiplier = classRates[rideClass] ?? DEFAULT_CLASS_RATES[rideClass];
      return {
        rideClass,
        multiplier,
        fare: applyClassMultiplier(base.fare, multiplier, rates.minimum),
        capacity: CLASS_CAPACITY[rideClass],
        source: base.source,
      };
    });

    return { tiers, currencyCode: base.currencyCode, distanceKm: base.distanceKm, durationMin: base.durationMin };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
