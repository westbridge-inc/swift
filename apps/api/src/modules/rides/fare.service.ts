import type { PrismaClient } from '@prisma/client';
import { estimateDrivingDistance } from '../../utils/distance';
import { pointInPolygon, type GeoPoint } from '../../utils/geo';
import { CountryConfigService } from '../country/country-config.service';

// ---------------------------------------------------------------------------
// Fare engine (master plan §4.2) — deterministic, computed and shown BEFORE
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
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
