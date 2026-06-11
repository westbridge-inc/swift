import type { PrismaClient, CountryConfig } from '@prisma/client';
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

  /** Required-document checklist for a role key (drives Step 4 verification). */
  async getDocumentChecklist(code: string, roleKey: string): Promise<string[]> {
    const config = await this.getByCode(code);
    const lists = config.documentChecklists as Record<string, string[]>;
    return lists[roleKey] ?? [];
  }
}
