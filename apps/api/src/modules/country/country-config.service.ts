import type { PrismaClient, CountryConfig, VehicleType } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';

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

  /** Required-document checklist for a role key (drives verification). */
  async getDocumentChecklist(code: string, roleKey: string): Promise<string[]> {
    const config = await this.getByCode(code);
    const lists = config.documentChecklists as Record<string, string[]>;
    return lists[roleKey] ?? [];
  }

  /**
   * Mover checklist, scaled to the vehicle so we never ask for documents a
   * vehicle can't have (a bicycle has no driver's licence or insurance):
   *   BICYCLE    → MOVER base (identity)
   *   MOTORCYCLE → base + MOVER_MOTOR (licence, registration, insurance)
   *   CAR (taxi) → the above + MOVER_TAXI_EXTRA (hire permit, plate photo,
   *                police clearance, fitness — spec §3.4)
   * Used both to display the checklist and to gate live operation.
   */
  async getMoverChecklist(code: string, vehicleType: VehicleType): Promise<string[]> {
    const config = await this.getByCode(code);
    const lists = config.documentChecklists as Record<string, string[]>;
    const base = lists['MOVER'] ?? [];
    if (vehicleType === 'BICYCLE') return base;
    const motor = [...base, ...(lists['MOVER_MOTOR'] ?? [])];
    return vehicleType === 'CAR' ? [...motor, ...(lists['MOVER_TAXI_EXTRA'] ?? [])] : motor;
  }
}
