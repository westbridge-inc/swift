import type { PrismaClient, CountryConfig, VehicleType } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import { mergeDeliveryRates, type DeliveryRates } from '../../utils/markup';
import { docProfilesFor } from '../../config/vehicle-classes';

/** Weekly subscription tiers in local currency. */
export interface SubscriptionTiers {
  mover: number;
  smallVendor: number;
  largeVendor: number;
  [tier: string]: number;
}

/**
 * Accessor for CountryConfig — currency, ID-gate threshold, subscription
 * tiers, and document checklists all come from here, never from constants.
 * Adding a country must be config, not code.
 */
export class CountryConfigService {
  constructor(private prisma: PrismaClient) {}

  async getByCode(code: string): Promise<CountryConfig> {
    const config = await this.prisma.countryConfig.findUnique({ where: { code } });
    if (!config) throw new NotFoundError('CountryConfig', code);
    return config;
  }

  /** Countries open for signup; inactive ones show a waitlist. */
  async getActiveCountries() {
    return this.prisma.countryConfig.findMany({
      where: { isActive: true },
      select: { code: true, name: true, currencyCode: true, currencySymbol: true },
      orderBy: { name: 'asc' },
    });
  }

  async getSubscriptionTiers(code: string): Promise<SubscriptionTiers> {
    const config = await this.getByCode(code);
    return config.subscriptionTiers as unknown as SubscriptionTiers;
  }

  /** The L2 ID-gate threshold converted to local currency. */
  async getIdGateThresholdLocal(code: string): Promise<number> {
    const config = await this.getByCode(code);
    return Number(config.idGateThresholdUsd) * Number(config.usdExchangeRate);
  }

  /** FUL-003b: the food/grocery delivery-fee schedule for a country, merged
   *  over code defaults. Resilient by design — a missing config falls back to
   *  the defaults rather than throwing, so a delivery fee never crashes
   *  checkout (unlike the ID gate, delivery pricing has a safe default). */
  async getDeliveryRates(code: string): Promise<DeliveryRates> {
    const config = await this.prisma.countryConfig.findUnique({
      where: { code },
      select: { deliveryRates: true },
    });
    return mergeDeliveryRates(config?.deliveryRates ?? null);
  }

  /** Required-document checklist for a role key (drives verification). */
  async getDocumentChecklist(code: string, roleKey: string): Promise<string[]> {
    const config = await this.getByCode(code);
    const lists = config.documentChecklists as Record<string, string[]>;
    return lists[roleKey] ?? [];
  }

  /**
   * Mover checklist, scaled to the vehicle so we never ask for documents a
   * vehicle can't have (a bicycle has no driver's licence or insurance). The
   * document profiles per vehicle live in the vehicle-class taxonomy
   * (config/vehicle-classes) — the single source of truth — so the base three
   * keep their exact lists while new vehicles (buses, box trucks) pull their
   * own profiles (e.g. MOVER_COMMERCIAL) on top of the base:
   *   BICYCLE    → MOVER base (identity + police clearance — master plan §3.2)
   *   MOTORCYCLE → base + MOVER_MOTOR (licence, registration, insurance)
   *   CAR (taxi) → the above + MOVER_TAXI_EXTRA (hire permit, plate photo,
   *                exterior car photo, fitness — master plan §3.1)
   * An unseeded profile key resolves to no extra documents. Used both to display
   * the checklist and to gate live operation.
   */
  async getMoverChecklist(code: string, vehicleType: VehicleType): Promise<string[]> {
    const config = await this.getByCode(code);
    const lists = config.documentChecklists as Record<string, string[]>;
    const base = lists['MOVER'] ?? [];
    const extra = docProfilesFor(vehicleType).flatMap((key) => lists[key] ?? []);
    return [...new Set([...base, ...extra])];
  }
}
