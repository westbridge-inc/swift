import type { PrismaClient, RideClass } from '@prisma/client';
import { estimateDrivingDistance } from '../../utils/distance';
import { pointInPolygon, type GeoPoint } from '../../utils/geo';
import { CountryConfigService } from '../country/country-config.service';

// ---------------------------------------------------------------------------
// Fare engine (master plan §4.2) — deterministic, computed and shown BEFORE
// any driver sees the request. Zone-to-zone table wins; gaps fall back to
// the CountryConfig formula. Never an AI call, never a post-hoc surprise.
//
// Ride classes (Uber-style car tiers) are a multiplier on the base fare: the
// STANDARD fare is computed once, then each class is base × its multiplier.
// ---------------------------------------------------------------------------

export interface TaxiRates {
  base: number;
  perKm: number;
  perMin: number;
  minimum: number;
}

const DEFAULT_RATES: TaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };
const AVG_SPEED_KMH = 25;

export const RIDE_CLASSES: RideClass[] = ['STANDARD', 'COMFORT', 'XL'];

// Multiplier on the base (STANDARD) fare. STANDARD is, by definition, 1.0.
const RIDE_CLASS_MULTIPLIER: Record<RideClass, number> = {
  STANDARD: 1,
  COMFORT: 1.5,
  XL: 1.8,
};

/** Apply a class multiplier to the base fare, cash-friendly rounding (nearest 100). */
export function applyRideClass(baseFare: number, rideClass: RideClass): number {
  return Math.round((baseFare * RIDE_CLASS_MULTIPLIER[rideClass]) / 100) * 100;
}

export interface FareEstimate {
  fare: number;
  rideClass: RideClass;
  currencyCode: string;
  distanceKm: number;
  durationMin: number;
  source: 'zone_table' | 'formula';
  fromZoneId?: string;
  toZoneId?: string;
}

export interface ClassFare {
  rideClass: RideClass;
  fare: number;
  multiplier: number;
}

interface BaseQuote {
  baseFare: number;
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

  /** Base (STANDARD) fare for the trip — zone table first, then the formula. */
  private async quote(pickup: GeoPoint, dropoff: GeoPoint, countryCode: string): Promise<BaseQuote> {
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
          baseFare: Number(zoneFare.fare),
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
    const baseFare = Math.max(rates.minimum, Math.round(raw / 100) * 100);

    return {
      baseFare,
      currencyCode: config.currencyCode,
      distanceKm: round1(distanceKm),
      durationMin,
      source: 'formula',
      fromZoneId: fromZone?.id,
      toZoneId: toZone?.id,
    };
  }

  /** Fare for one class (defaults to STANDARD). */
  async estimate(
    pickup: GeoPoint,
    dropoff: GeoPoint,
    countryCode: string,
    rideClass: RideClass = 'STANDARD',
  ): Promise<FareEstimate> {
    const q = await this.quote(pickup, dropoff, countryCode);
    return { ...toEstimate(q, rideClass) };
  }

  /** Every ride class priced for the trip — the customer's selection screen. */
  async estimateAll(
    pickup: GeoPoint,
    dropoff: GeoPoint,
    countryCode: string,
  ): Promise<FareEstimate & { classes: ClassFare[] }> {
    const q = await this.quote(pickup, dropoff, countryCode);
    const classes: ClassFare[] = RIDE_CLASSES.map((rc) => ({
      rideClass: rc,
      fare: applyRideClass(q.baseFare, rc),
      multiplier: RIDE_CLASS_MULTIPLIER[rc],
    }));
    return { ...toEstimate(q, 'STANDARD'), classes };
  }
}

function toEstimate(q: BaseQuote, rideClass: RideClass): FareEstimate {
  return {
    fare: applyRideClass(q.baseFare, rideClass),
    rideClass,
    currencyCode: q.currencyCode,
    distanceKm: q.distanceKm,
    durationMin: q.durationMin,
    source: q.source,
    fromZoneId: q.fromZoneId,
    toZoneId: q.toZoneId,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
