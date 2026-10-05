import { identityAuthority, requireIdentityAuthority } from '../modules/integrity/identity-review';
import { previewTrial } from '../modules/integrity/enforcement';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../modules/billing/billing.service';
import { IdentityService } from '../modules/integrity/identity.service';
import { runIdentityBackfill } from '../modules/integrity/backfill';
import { TrialEntitlementService } from '../modules/integrity/trial-entitlement.service';

// [#1393] setBillingRail now runs inside the shared weekly-fee authority (the
// payer and mover-fee locks and the dunning clock). This suite doubles that
// authority exactly as it doubles persistence: the declaration -> capture ->
// identity chain below is what it grades, unchanged.
vi.mock('../modules/subscription/mover-fee-authority', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modules/subscription/mover-fee-authority')>(),
  lockFeeCollectionAuthority: async () => ({ allowed: true }),
}));
vi.mock('../modules/billing/dunning-clock', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modules/billing/dunning-clock')>(),
  lockBillingAuthority: async (db: any, subscriptionId: string) => ({
    sub: await db.subscription.findUnique({ where: { id: subscriptionId } }), userId: 'synthetic-payer', tenantId: 'safeb-tenant', userStatus: 'ACTIVE',
  }),
  currentDunningClock: async () => ({ pausedAt: null }),
  projectDunningClock: async () => undefined,
}));

// Real declaration -> capture hook -> identity matcher -> union -> enforcement.
// Only persistence is doubled. All accounts, payer numbers and grants are synthetic.
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const state = {
    keys: [] as any[], enforcement: [] as any[],
    clusters: [
      { id: 'safeb-cluster-a', createdAt: new Date('2026-01-01'), mergedIntoId: null as string | null },
      { id: 'safeb-cluster-b', createdAt: new Date('2026-02-01'), mergedIntoId: null as string | null },
    ],
    members: [
      { accountId: 'safeb-account-a', clusterId: 'safeb-cluster-a', linkedVia: [] },
      { accountId: 'safeb-account-b', clusterId: 'safeb-cluster-b', linkedVia: [] },
    ] as any[],
    grants: [
      { id: 'safeb-grant-a', accountId: 'safeb-account-a', clusterId: 'safeb-cluster-a', tenantId: 'safeb-tenant', role: 'RIDER', status: 'ACTIVE', startedAt: new Date('2026-01-01') },
      { id: 'safeb-grant-b', accountId: 'safeb-account-b', clusterId: 'safeb-cluster-b', tenantId: 'safeb-tenant', role: 'RIDER', status: 'ACTIVE', startedAt: new Date('2026-02-01') },
    ] as any[],
    subscriptions: ['a', 'b'].map((suffix) => ({
      id: `safeb-sub-${suffix}`, status: 'ACTIVE', currencyCode: 'GYD', billingMethod: 'CASH',
      mmgPayerMsisdn: null as string | null,
      rider: { userId: `safeb-account-${suffix}` }, driver: null, vendor: null,
    })),
  };
  const by = (rows: any[], field: string, value: string) => rows.find(row => row[field] === value);
  const matchesKey = (row: any, where: any) => row.type === where.type && row.valueHash === where.valueHash
    && (typeof where.accountId === 'string' ? row.accountId === where.accountId : row.accountId !== where.accountId.not);
  const db: any = {
    $queryRaw: vi.fn(async (sql: any) => {
      const text = typeof sql?.sql === 'string' ? sql.sql : Array.from(sql).join(' ');
      if (text.includes('subscriptions')) return [{ status: 'ACTIVE' }];
      if (text.includes('users')) return [{ tenantId: 'safeb-tenant', status: 'ACTIVE' }];
      return [];
    }),
    $transaction: vi.fn(async (fn: any) => fn(db)),
    user: { findFirst: vi.fn(async () => null), findMany: vi.fn(async ({ where }: any) => where?.id ? state.members.map(m => ({
      id: m.accountId, phone: null, firstName: 'Synthetic', lastName: 'Account', roles: ['RIDER'],
    })) : []) },
    driver: { findMany: vi.fn(async () => []) },
    subscription: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }: any) => by(state.subscriptions, 'id', where.id)),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => by(state.subscriptions, 'id', where.id)),
      findMany: vi.fn(async () => state.subscriptions.filter(s => s.mmgPayerMsisdn)),
      update: vi.fn(async ({ where, data }: any) => Object.assign(by(state.subscriptions, 'id', where.id), data)),
    },
    billingEvent: { create: vi.fn(async ({ data }: any) => data) },
    subscriptionPayment: { findMany: vi.fn(async () => []) },
    providerPayment: { findMany: vi.fn(async () => []) },
    mmgPayerEvidence: { upsert: vi.fn(async ({ create }: any) => create) },
    identityKey: {
      findFirst: vi.fn(async ({ where }: any) => state.keys.find(row => matchesKey(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => state.keys.filter(row => matchesKey(row, where))),
      create: vi.fn(async ({ data }: any) => { const row = { id: `safeb-key-${state.keys.length}`, ...data }; state.keys.push(row); return row; }),
    },
    identityCluster: {
      findUnique: vi.fn(async ({ where }: any) => by(state.clusters, 'id', where.id)),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => by(state.clusters, 'id', where.id)),
      update: vi.fn(async ({ where, data }: any) => Object.assign(by(state.clusters, 'id', where.id), data)),
    },
    identityClusterMember: {
      findUnique: vi.fn(async ({ where }: any) => by(state.members, 'accountId', where.accountId)),
      findMany: vi.fn(async ({ where }: any) => state.members.filter(m => m.clusterId === where.clusterId)),
      update: vi.fn(async ({ where, data }: any) => Object.assign(by(state.members, 'accountId', where.accountId), data)),
      groupBy: vi.fn(async () => state.clusters.filter(c => state.members.filter(m => m.clusterId === c.id).length > 1).map(c => ({ clusterId: c.id }))),
    },
    trialGrant: {
      findMany: vi.fn(async ({ where }: any) => state.grants.filter(g => typeof where.clusterId === 'string'
        ? g.clusterId === where.clusterId : where.clusterId.in.includes(g.clusterId)).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())),
      update: vi.fn(async ({ where, data }: any) => Object.assign(by(state.grants, 'id', where.id), data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state.grants.filter(g => g.clusterId === where.clusterId);
        rows.forEach(g => Object.assign(g, data)); return { count: rows.length };
      }),
    },
    enforcementAction: { create: vi.fn(async ({ data }: any) => { state.enforcement.push(data); return data; }) },
    exceptionGrant: { findFirst: vi.fn(async () => null) },
  };
  const calls: Promise<unknown>[] = [];
  const capture = IdentityService.prototype.capture;
  const captureSpy = vi.spyOn(IdentityService.prototype, 'capture').mockImplementation(function (this: IdentityService, input) {
    const result = capture.call(this, input); calls.push(result); return result;
  });
  const payments = { charge: vi.fn(() => { throw new Error('unexpected provider call'); }) };
  const billing = new BillingService(db, {} as never, payments as never);
  const drain = async () => { await Promise.all(calls); expect(db.mmgPayerEvidence.upsert).toHaveBeenCalledTimes(2); expect(captureSpy).not.toHaveBeenCalled(); };
  return { state, db, billing, payments, captureSpy, drain };
}

describe('MMG payer declaration has no identity authority', () => {
  it('changing two billing rails to one unverified payer does not merge or revoke a trial', async () => {
    const h = fixture();
    for (const sub of h.state.subscriptions) await h.billing.setBillingRail(sub.id, 'MOBILE_MONEY', '+5920000000');
    await h.drain();
    expect(h.db.subscription.update).toHaveBeenCalledTimes(2);
    expect(h.payments.charge).not.toHaveBeenCalled();
    expect.soft(h.state.members.map(m => m.clusterId)).toEqual(['safeb-cluster-a', 'safeb-cluster-b']);
    expect.soft(h.state.grants.map(g => g.status)).toEqual(['ACTIVE', 'ACTIVE']);
    expect.soft(h.state.enforcement).toHaveLength(0);
  });

  it('backfill cannot turn declared payer numbers into authority or revoke existing grants', async () => {
    const h = fixture();
    h.state.subscriptions.forEach(s => { s.mmgPayerMsisdn = '+5920000000'; });
    const report = await runIdentityBackfill(h.db);
    expect(report.scanned.mmgRails).toBe(2);
    expect(h.db.mmgPayerEvidence.upsert).toHaveBeenCalledTimes(2);
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect.soft(h.state.members.map(m => m.clusterId)).toEqual(['safeb-cluster-a', 'safeb-cluster-b']);
    expect.soft(h.state.grants.map(g => g.status)).toEqual(['ACTIVE', 'ACTIVE']);
    expect.soft(h.state.enforcement).toHaveLength(0);
  });

  it('the identity admission boundary refuses HARD MMG capture without settled payer provenance', async () => {
    const h = fixture();
    const identity = new IdentityService(h.db);
    const first = await identity.capture({ accountId: 'safeb-account-a', actorRole: 'RIDER', type: 'MMG_PAYER', normalizedValue: '5920000000', source: 'BILLING' });
    const result = await identity.capture({ accountId: 'safeb-account-b', actorRole: 'RIDER', type: 'MMG_PAYER', normalizedValue: '5920000000', source: 'BILLING' });
    expect.soft(result.merged).toBe(false);
    expect.soft(first.dropped).toBe(true);
    expect.soft(result.dropped).toBe(true);
    expect.soft(h.state.keys).toHaveLength(0);
    expect.soft(h.db.identityKey.create).not.toHaveBeenCalled();
    expect.soft(h.state.enforcement).toHaveLength(0);
    expect.soft(h.state.grants[1].status).toBe('ACTIVE');
  });

  it('declaring another account payer cannot deny a first trial on the untouched account', async () => {
    const h = fixture();
    // Account B has never held a grant; A has an active grant for the same role.
    h.state.grants = h.state.grants.filter(g => g.accountId === 'safeb-account-a');
    const entitlement = new TrialEntitlementService(h.db);
    expect(await entitlement.decide('safeb-account-b', 'RIDER', 'safeb-tenant')).toMatchObject({ grant: true, reason: 'FIRST_TRIAL' });
    for (const sub of h.state.subscriptions) await h.billing.setBillingRail(sub.id, 'MOBILE_MONEY', '+5920000000');
    await h.drain();
    const result = await entitlement.decide('safeb-account-b', 'RIDER', 'safeb-tenant');
    expect(result).toMatchObject({ grant: true, reason: 'FIRST_TRIAL' });
  });
});


describe('legacy ambiguous identity authority', () => {
  it('exposes REVIEW_REQUIRED without grants, enforcement, split or restoration', async () => {
    const h = fixture();
    Object.assign(h.state.clusters[0]!, { authorityReviewRequired: true });
    const original = JSON.stringify({ grants: h.state.grants, members: h.state.members, keys: h.state.keys });
    const resolution = await identityAuthority(h.db, 'safeb-account-a');
    expect(resolution.status).toBe('REVIEW_REQUIRED');
    expect(await new TrialEntitlementService(h.db).decide('safeb-account-a', 'RIDER', 'safeb-tenant')).toMatchObject({ grant: false, reason: 'REVIEW_REQUIRED' });
    expect(await previewTrial(h.db, 'safeb-account-a', 'RIDER', 'safeb-tenant')).toMatchObject({ willTrial: false, reason: 'REVIEW_REQUIRED' });
    await expect(requireIdentityAuthority(h.db, 'safeb-account-a')).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
    expect(h.state.enforcement).toHaveLength(0);
    expect(JSON.stringify({ grants: h.state.grants, members: h.state.members, keys: h.state.keys })).toBe(original);
  });
  it('propagates unresolved hard matches to both roots without union or punishment', async () => {
    const h = fixture();
    Object.assign(h.state.clusters[0]!, { authorityReviewRequired: true });
    const identity = new IdentityService(h.db);
    await identity.capture({ accountId: 'safeb-account-a', actorRole: 'RIDER', type: 'PHONE', normalizedValue: '+5920000000', source: 'SYNTHETIC_AUTH' });
    const result = await identity.capture({ accountId: 'safeb-account-b', actorRole: 'RIDER', type: 'PHONE', normalizedValue: '+5920000000', source: 'SYNTHETIC_AUTH' });
    expect(result.merged).toBe(false);
    expect((await identityAuthority(h.db, 'safeb-account-b')).status).toBe('REVIEW_REQUIRED');
    expect(h.state.members.map(m => m.clusterId)).toEqual(['safeb-cluster-a', 'safeb-cluster-b']);
    expect(h.state.grants.map(g => g.status)).toEqual(['ACTIVE', 'ACTIVE']);
  });
  it('caller-named durable payer evidence and alleged provider contract cannot enable HARD identity', async () => {
    const h = fixture();
    h.db.mmgPayerEvidence.findUnique = vi.fn(async () => ({
      accountId: 'safeb-account-a', tenantId: 'safeb-tenant', actorRole: 'RIDER',
      payerHash: (await import('../modules/integrity/normalize')).hashSignal('+5920000000'),
      tier: 'PROVIDER_SETTLED', settledAt: new Date(), providerContract: 'CALLER_SAYS_VERIFIED',
    }));
    const result = await new IdentityService(h.db).capture({ accountId: 'safeb-account-a', actorRole: 'RIDER', type: 'MMG_PAYER', normalizedValue: '+5920000000', source: 'BILLING', mmgEvidenceId: 'untrusted-proof' });
    expect(result.dropped).toBe(true); expect(h.state.keys).toHaveLength(0);
  });
  it('cycles and missing roots remain unresolved rather than becoming singletons', async () => {
    const h = fixture();
    h.state.clusters[0]!.mergedIntoId = 'safeb-cluster-b'; h.state.clusters[1]!.mergedIntoId = 'safeb-cluster-a';
    expect((await identityAuthority(h.db, 'safeb-account-a')).status).toBe('REVIEW_REQUIRED');
    h.state.clusters[1]!.mergedIntoId = 'missing-root';
    expect((await identityAuthority(h.db, 'safeb-account-a')).status).toBe('REVIEW_REQUIRED');
  });
});
