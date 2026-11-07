import { describe, expect, it } from 'vitest';
import {
  moverUserIdOf, moverUserOf, ownerOfRow, ownerTenantOf, PAYER_INCLUDE, payerAudienceOf, payerOf, payerUserIdOf, personUserOf,
  subscriptionPaidBySql, subscriptionsPaidBy, subscriptionTenantInTx, subscriptionTenantSql, subscriptionTenantWhere,
} from '../modules/subscription/subscription-owner';

// [BILL-PRO PR0] The one subscription-owner module keeps the exact rule of the
// inline copies it replaced: the payer is the rider's user, else the driver's,
// else the store owner's. Synthetic ids only.

const rider = { userId: 'u-rider' };
const driver = { userId: 'u-driver' };
const vendor = { owner: { userId: 'u-owner' } };
const user = (id: string, tenantId = 't-1') => ({ id, tenantId });

describe('the payer of a loaded subscription', () => {
  it('rider, then driver, then the store owner; nothing loaded is nobody', () => {
    expect(payerUserIdOf({ rider, driver, vendor })).toBe('u-rider');
    expect(payerUserIdOf({ rider: null, driver, vendor })).toBe('u-driver');
    expect(payerUserIdOf({ rider: null, driver: null, vendor })).toBe('u-owner');
    expect(payerUserIdOf({ rider: null, driver: null, vendor: null })).toBeNull();
    expect(payerUserIdOf({})).toBeNull();
    expect(payerUserIdOf(null)).toBeNull();
    expect(payerUserIdOf(undefined)).toBeNull();
  });

  it('the mover payer is never a store owner', () => {
    expect(moverUserIdOf({ rider, driver })).toBe('u-rider');
    expect(moverUserIdOf({ rider: null, driver })).toBe('u-driver');
    expect(moverUserIdOf({ rider: null, driver: null, ...{ vendor } } as never)).toBeNull();
    expect(moverUserIdOf(null)).toBeNull();
  });

  it('payerOf names the role in the same order', () => {
    expect(payerOf({ rider, driver: null, vendor: null })).toEqual({ userId: 'u-rider', kind: 'RIDER' });
    expect(payerOf({ rider: null, driver, vendor: null })).toEqual({ userId: 'u-driver', kind: 'DRIVER' });
    expect(payerOf({ rider: null, driver: null, vendor })).toEqual({ userId: 'u-owner', kind: 'VENDOR' });
    expect(payerOf({ rider: null, driver: null, vendor: null })).toBeNull();
    expect(payerOf(null)).toBeNull();
  });

  it("a store's notice goes to the business app, a mover's to the earner app", () => {
    expect(payerAudienceOf({ vendor })).toBe('business');
    expect(payerAudienceOf({ vendor: 'v-1' })).toBe('business');
    expect(payerAudienceOf({ vendor: null })).toBe('earner');
    expect(payerAudienceOf({ vendor: undefined })).toBe('earner');
    expect(payerAudienceOf(null)).toBe('earner');
  });

  it("the mover's own user record (display names, numbers)", () => {
    expect(moverUserOf({ rider: { user: { name: 'r' } }, driver: { user: { name: 'd' } } })).toEqual({ name: 'r' });
    expect(moverUserOf({ rider: null, driver: { user: { name: 'd' } } })).toEqual({ name: 'd' });
    expect(moverUserOf({ rider: null, driver: null })).toBeNull();
    expect(moverUserOf(null)).toBeNull();
  });
});

describe('the owner of a row read with SUBSCRIPTION_OWNER_SELECT', () => {
  const row = (over: Record<string, unknown>) => ({ riderId: null, driverId: null, vendorId: null, rider: null, driver: null, vendor: null, ...over }) as never;

  it('one owner of each kind', () => {
    expect(ownerOfRow(row({ riderId: 'r', rider: { user: user('u-r') } }))).toEqual({ kind: 'RIDER', userId: 'u-r', tenantId: 't-1', ownerColumns: 1 });
    expect(ownerOfRow(row({ driverId: 'd', driver: { user: user('u-d', 't-2') } }))).toEqual({ kind: 'DRIVER', userId: 'u-d', tenantId: 't-2', ownerColumns: 1 });
    expect(ownerOfRow(row({ vendorId: 'v', vendor: { tenantId: 't-1', owner: { user: user('u-o') } } })))
      .toEqual({ kind: 'VENDOR', userId: 'u-o', tenantId: 't-1', vendorId: 'v', ownerColumns: 1 });
  });

  it('a malformed row is reported, never silently resolved to a different rule', () => {
    expect(ownerOfRow(row({}))).toBeNull();
    expect(ownerOfRow(row({ riderId: 'r' }))).toBeNull(); // owner column set, owner row not found
    expect(ownerOfRow(row({ riderId: 'r', rider: { user: user('u-r') }, vendorId: 'v', vendor: { tenantId: 't-1', owner: { user: user('u-o') } } })))
      .toEqual({ kind: 'RIDER', userId: 'u-r', tenantId: 't-1', vendorId: 'v', ownerColumns: 2 });
  });

  it("the owner tenant: a store's own tenant, else the mover's user's", () => {
    expect(ownerTenantOf({ vendor: { tenantId: 't-v' }, rider: { user: { tenantId: 't-r' } } })).toBe('t-v');
    expect(ownerTenantOf({ vendor: null, rider: { user: { tenantId: 't-r' } }, driver: { user: { tenantId: 't-d' } } })).toBe('t-r');
    expect(ownerTenantOf({ vendor: null, rider: null, driver: { user: { tenantId: 't-d' } } })).toBe('t-d');
    expect(ownerTenantOf({})).toBeNull();
  });
});

describe('the Prisma filters are the replaced literals, plus the pro (BILL-PRO PR2)', () => {
  it('every subscription a person pays', () => {
    expect(subscriptionsPaidBy('u-1')).toEqual({ OR: [{ rider: { userId: 'u-1' } }, { driver: { userId: 'u-1' } }, { vendor: { owner: { userId: 'u-1' } } }, { serviceProvider: { userId: 'u-1' } }] });
    const some = { in: ['u-1', 'u-2'] };
    expect(subscriptionsPaidBy(some)).toEqual({ OR: [{ rider: { userId: some } }, { driver: { userId: some } }, { vendor: { owner: { userId: some } } }, { serviceProvider: { userId: some } }] });
  });

  it('the one-owner tenant scope', () => {
    expect(subscriptionTenantWhere('t-1')).toEqual({ OR: [
      { vendor: { tenantId: 't-1' }, riderId: null, driverId: null, serviceProviderId: null },
      { rider: { user: { tenantId: 't-1' } }, vendorId: null, driverId: null, serviceProviderId: null },
      { driver: { user: { tenantId: 't-1' } }, vendorId: null, riderId: null, serviceProviderId: null },
      { serviceProvider: { user: { tenantId: 't-1' } }, vendorId: null, riderId: null, driverId: null },
    ] });
  });
});

describe('the SQL', () => {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

  it('subscriptionTenantInTx runs exactly the subscriptionTenantSql statement, bound to the subscription', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tx = { $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ text: strings.join('?'), values }); return [{ tenantId: 't-9' }]; } };
    expect(await subscriptionTenantInTx(tx as never, 'sub-1')).toBe('t-9');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['sub-1']);
    expect(flat(calls[0]!.text)).toBe(flat(`SELECT u."tenantId" AS "tenantId" FROM "subscriptions" s ${subscriptionTenantSql.sql} WHERE s."id" = ?`));
    expect(subscriptionTenantSql.values).toEqual([]);
  });

  it('no payer found is an error, never a guessed tenant', async () => {
    const tx = { $queryRaw: async () => [] };
    await expect(subscriptionTenantInTx(tx as never, 'sub-1')).rejects.toMatchObject({ code: 'SUBSCRIPTION_TENANT_UNKNOWN' });
  });

  it('the paid-by condition names the person once per owner role', () => {
    const cond = subscriptionPaidBySql('u-1');
    expect(flat(cond.sql)).toBe('(r."userId" = ? OR d."userId" = ? OR vo."userId" = ? OR sp."userId" = ?)');
    expect(cond.values).toEqual(['u-1', 'u-1', 'u-1', 'u-1']);
  });
});

describe('the pro (BILL-PRO PR2): a fourth owner, paid by the pro', () => {
  const pro = { userId: 'u-pro' };
  const row = (over: Record<string, unknown>) => ({ riderId: null, driverId: null, vendorId: null, serviceProviderId: null, rider: null, driver: null, vendor: null, serviceProvider: null, ...over }) as never;

  it('the pro pays, after the three older owners (only a legacy row can have two)', () => {
    expect(payerUserIdOf({ rider: null, driver: null, vendor: null, serviceProvider: pro })).toBe('u-pro');
    expect(payerOf({ rider: null, driver: null, vendor: null, serviceProvider: pro })).toEqual({ userId: 'u-pro', kind: 'PROVIDER' });
    expect(payerUserIdOf({ rider, driver: null, vendor: null, serviceProvider: pro })).toBe('u-rider');
    expect(moverUserIdOf({ rider: null, driver: null, ...{ serviceProvider: pro } } as never)).toBeNull();
  });

  it("a pro row read without its owner is refused, never answered 'nobody pays'", () => {
    expect(() => payerUserIdOf({ serviceProviderId: 'sp-1', rider: null, driver: null, vendor: null })).toThrow(expect.objectContaining({ code: 'PAYER_NOT_LOADED' }));
    expect(() => payerOf({ serviceProviderId: 'sp-1' })).toThrow(expect.objectContaining({ code: 'PAYER_NOT_LOADED' }));
    // Loaded and gone (the profile was deleted): nobody, as for every other owner.
    expect(payerUserIdOf({ serviceProviderId: 'sp-1', serviceProvider: null })).toBeNull();
  });

  it("a pro's notice goes to the provider surface, never the earner app", () => {
    expect(payerAudienceOf({ serviceProvider: pro })).toBe('provider');
    expect(payerAudienceOf({ serviceProviderId: 'sp-1' })).toBe('provider');
    expect(payerAudienceOf({ vendorId: 'v-1' })).toBe('business');
    expect(payerAudienceOf({ vendorId: null, serviceProviderId: null })).toBe('earner');
  });

  it("the pro's own user record names the pro on receipts; a mover still comes first", () => {
    expect(personUserOf({ rider: null, driver: null, serviceProvider: { user: { name: 'p' } } })).toEqual({ name: 'p' });
    expect(personUserOf({ rider: { user: { name: 'r' } }, driver: null, serviceProvider: null })).toEqual({ name: 'r' });
    expect(personUserOf({ rider: null, driver: null, serviceProvider: null })).toBeNull();
    expect(moverUserOf({ rider: null, driver: null, ...{ serviceProvider: { user: { name: 'p' } } } } as never)).toBeNull();
  });

  it('a row read with SUBSCRIPTION_OWNER_SELECT: the pro, its tenant, and two owners still reported', () => {
    expect(ownerOfRow(row({ serviceProviderId: 'sp', serviceProvider: { user: user('u-p', 't-3') } })))
      .toEqual({ kind: 'PROVIDER', userId: 'u-p', tenantId: 't-3', serviceProviderId: 'sp', ownerColumns: 1 });
    expect(ownerOfRow(row({ serviceProviderId: 'sp' }))).toBeNull();
    expect(ownerOfRow(row({ riderId: 'r', rider: { user: user('u-r') }, serviceProviderId: 'sp', serviceProvider: { user: user('u-p') } })))
      .toMatchObject({ kind: 'RIDER', ownerColumns: 2 });
    expect(ownerTenantOf({ vendor: null, rider: null, driver: null, serviceProvider: { user: { tenantId: 't-p' } } })).toBe('t-p');
  });

  it('PAYER_INCLUDE loads all four owners', () => {
    expect(Object.keys(PAYER_INCLUDE).sort()).toEqual(['driver', 'rider', 'serviceProvider', 'vendor']);
    expect(PAYER_INCLUDE.serviceProvider).toEqual({ select: { userId: true } });
  });
});
