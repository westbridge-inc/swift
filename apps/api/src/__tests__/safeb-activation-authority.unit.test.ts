import { describe, expect, it, vi } from 'vitest';
vi.mock('../modules/country/country-config.service', () => ({
  CountryConfigService: class { async getSubscriptionTiers() { return {}; } async getCurrencyCode() { return 'GYD'; } },
  partnerRateFor: () => ({ rate: 6000 }),
}));
// [#1393] A mover activation also takes the payer's mover-fee locks and joins
// its one shared weekly-fee authority (proved against PostgreSQL in
// mover-fee-authority.test.ts and mover-fee-band.test.ts). This suite doubles
// that authority, so the identity-authority guarantees below stay what it grades.
vi.mock('../modules/subscription/mover-fee-authority', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modules/subscription/mover-fee-authority')>(),
  lockMoverSources: async () => [],
  resolveMoverFeeAuthority: async (db: any) => {
    const existing = (await db.rider.findUnique({}))?.subscription;
    return existing ? { canonicalSubscriptionId: existing.id, feeType: existing.type } : null;
  },
  activateMoverFeeType: async (_tx: unknown, _payer: unknown, feeType: string) => ({ feeType }),
  lockMoverFeeAuthority: async () => null,
}));
import { SubscriptionService } from '../modules/subscription/subscription.service';

function fixture() {
  const state = { review: false, banned: false, active: false, subs: [] as any[], grants: [] as any[], actions: [] as any[], trace: [] as string[] };
  const tx: any = {
    $queryRaw: async () => { state.trace.push('lock'); return []; },
    rider: { findUnique: async () => ({ riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', user: { countryCode: 'GY' }, subscription: state.subs[0] }), findUniqueOrThrow: async () => ({ userId: 'synthetic-account', user: { id: 'synthetic-account', tenantId: 'swift-default' } }) },
    identityClusterMember: { findUnique: async () => ({ clusterId: 'synthetic-cluster' }), findMany: async () => [{ accountId: 'synthetic-account' }] },
    identityCluster: { findUnique: async () => ({ mergedIntoId: null, authorityReviewRequired: state.review }) },
    user: { findFirst: async () => state.banned ? { id: 'independently-banned-peer' } : null },
    subscription: { findFirst: async () => null, findUniqueOrThrow: async ({ where }: any) => state.subs.find((s) => s.id === where.id), create: async ({ data }: any) => { state.trace.push('subscription'); const row = { id: 'synthetic-sub', ...data }; state.subs.push(row); return row; } },
    trialGrant: { findMany: async () => state.grants, create: async ({ data }: any) => { state.trace.push('grant'); state.grants.push(data); return data; } },
    exceptionGrant: { findFirst: async () => null },
    enforcementAction: { create: async ({ data }: any) => { state.actions.push(data); return data; } },
  };
  const db: any = { ...tx, $transaction: async (fn: any) => {
    const original = { active: state.active, subs: [...state.subs], grants: [...state.grants], actions: [...state.actions] };
    try { return await fn(tx); } catch (err) { Object.assign(state, original); throw err; }
  } };
  return { state, service: new SubscriptionService(db) };
}

describe('identity authority and activation share one transaction', () => {
  it('commits a legitimate trial and projection behind the identity lock', async () => {
    const h = fixture();
    await h.service.withActivation({ riderId: 'synthetic-rider' }, async () => { h.state.trace.push('activation'); h.state.active = true; });
    expect(h.state.trace[0]).toBe('lock');
    expect(h.state.subs[0].status).toBe('TRIAL'); expect(h.state.grants).toHaveLength(1);
    expect(h.state.trace.indexOf('activation')).toBeGreaterThan(h.state.trace.indexOf('grant'));
  });
  it('quarantine after a preflight but before the transaction creates no subscription, grant, punishment or activation', async () => {
    const h = fixture();
    await h.service.priceForActivation({ riderId: 'synthetic-rider' }); h.state.review = true;
    await expect(h.service.withActivation({ riderId: 'synthetic-rider' }, async () => { h.state.active = true; })).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
    expect(h.state.subs).toEqual([]); expect(h.state.grants).toEqual([]); expect(h.state.actions).toEqual([]); expect(h.state.active).toBe(false);
  });
  it('projection failure rolls back the subscription, grant and denial facts', async () => {
    const h = fixture(); h.state.banned = true;
    await expect(h.service.withActivation({ riderId: 'synthetic-rider' }, async () => { throw new Error('synthetic projection failure'); })).rejects.toThrow('synthetic projection failure');
    expect(h.state.subs).toEqual([]); expect(h.state.grants).toEqual([]); expect(h.state.actions).toEqual([]);
  });
  it('existing legitimate subscription survives review without a new grant or charge', async () => {
    const h = fixture(); h.state.review = true; h.state.subs.push({ id: 'existing-sub', status: 'TRIAL' });
    await h.service.withActivation({ riderId: 'synthetic-rider' }, async () => { h.state.active = true; });
    expect(h.state.active).toBe(true); expect(h.state.subs).toHaveLength(1); expect(h.state.grants).toEqual([]); expect(h.state.actions).toEqual([]);
  });
});
