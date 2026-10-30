import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desiredPlatformConfig, guyanaTiers, PLATFORM_CONFIG_VERSION } from '../modules/ops/platform-config';
import { partnerPriceList } from '../modules/country/partner-pricing';
import { DEPARTMENT_TRIAL_DAYS, DEPARTMENT_TRIAL_SINCE, TRIAL_DAYS, trialDaysFor } from '../modules/subscription/trial-length';
import { TRIAL_DAYS as SERVICE_TRIAL_DAYS } from '../modules/subscription/subscription.service';

// ---------------------------------------------------------------------------
// [DEPT-PRICE · owner 29 Oct 2026 ~22:31Z] The department-store tier's weekly
// fee is GY$45,000 (was 60,000), and department stores ONLY get a 7-day free
// trial — for NEW signups. Every other partner keeps 14 days; a trial already
// running is never touched. Service-free: no database, no Redis.
// ---------------------------------------------------------------------------

const gy = () => desiredPlatformConfig().countries.find((c) => c.code === 'GY')!.policy as { subscriptionTiers: Record<string, unknown> };

describe('department tier price — GY$45,000', () => {
  it('the Guyana card prices the department tier at 45,000 and leaves every other rate alone', () => {
    expect(guyanaTiers.departmentVendor).toBe(45000);
    expect(gy().subscriptionTiers).toMatchObject({
      mover: 6000, moverHeavy: 9000, taxiDriver: 8000, serviceVendor: 8000,
      smallVendor: 15000, largeVendor: 20000, departmentVendor: 45000,
      largeCatalogueThreshold: 1000, departmentCatalogueThreshold: 10000,
    });
  });

  it('a new rate card is a new config version (production gets it only through the seed)', () => {
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-10-29.1');
    expect(desiredPlatformConfig().version).toBe('2026-10-29.1');
  });

  it('the USD-pegged markets keep their own launch anchor: re-pricing Guyana re-prices Guyana alone', () => {
    const tt = desiredPlatformConfig().countries.find((c) => c.code === 'TT')!.policy as { subscriptionTiers: Record<string, number> };
    expect(tt.subscriptionTiers['departmentVendor']).toBe(1600);
  });

  it('the public price list quotes 45,000 for 10,000+ items, with no other number moved', () => {
    const list = partnerPriceList(gy().subscriptionTiers);
    expect(list.vendors.catalogue.map(({ minItems, tier, rate }) => ({ minItems, tier, rate }))).toEqual([
      { minItems: 0, tier: 'small', rate: 15000 },
      { minItems: 1000, tier: 'large', rate: 20000 },
      { minItems: 10000, tier: 'department', rate: 45000 },
    ]);
    // The legacy figures an older app reads never under-state a bill: 1,000+ stands for the department bill.
    expect(list.weekly.largeVendor).toBe(45000);
    expect(list.weekly.departmentVendor).toBe(45000);
  });
});

describe('trial length per tier — department stores 7 days for NEW signups, everyone else 14', () => {
  const after = new Date(DEPARTMENT_TRIAL_SINCE.getTime() + 1);
  const before = new Date(DEPARTMENT_TRIAL_SINCE.getTime() - 1);

  it('the numbers are the owner\'s', () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(SERVICE_TRIAL_DAYS).toBe(14);
    expect(DEPARTMENT_TRIAL_DAYS).toBe(7);
    expect(DEPARTMENT_TRIAL_SINCE.toISOString()).toBe('2026-10-29T22:31:00.000Z');
  });

  it('a department-tier store that signed up after the ruling gets 7 days', () => {
    expect(trialDaysFor({ tier: 'department', storeCreatedAt: after })).toBe(7);
    expect(trialDaysFor({ tier: 'department', storeCreatedAt: DEPARTMENT_TRIAL_SINCE })).toBe(7);
  });

  it('a department-tier store that signed up before the ruling keeps the 14 days it was offered', () => {
    expect(trialDaysFor({ tier: 'department', storeCreatedAt: before })).toBe(14);
  });

  it('every other tier keeps 14 days', () => {
    for (const tier of ['small', 'large', 'service', 'courier', 'courierHeavy', 'taxi'] as const) {
      expect(trialDaysFor({ tier, storeCreatedAt: after }), tier).toBe(14);
    }
  });

  it('the price list tells each catalogue step its own trial, and keeps the one number build 12 reads at 14', () => {
    const list = partnerPriceList(gy().subscriptionTiers);
    expect(list.vendors.catalogue.map(({ tier, trialDays }) => [tier, trialDays])).toEqual([['small', 14], ['large', 14], ['department', 7]]);
  });

  it('GET /auth/pricing keeps the top-level trialDays at the 14 days every new store starts on', () => {
    const src = readFileSync(join(__dirname, '../modules/auth/auth.routes.ts'), 'utf8');
    expect(src).toMatch(/trialDays: TRIAL_DAYS,/);
  });
});
