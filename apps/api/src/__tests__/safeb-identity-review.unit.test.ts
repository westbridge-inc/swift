import { describe, expect, it, vi } from 'vitest';
import { retainIdentityReview, stageIdentityReviewCases } from '../modules/integrity/identity-review';
function fixture() {
  const state = { root: { id: 'review-root', authorityReviewRequired: true, mergedIntoId: null },
    members: [{ accountId: 'synthetic-a', clusterId: 'review-root', linkedVia: [{ type: 'MMG_PAYER' }] }],
    keys: [{ id: 'legacy-key', accountId: 'synthetic-a', type: 'MMG_PAYER', valueHash: 'synthetic-hash', mmgEvidenceId: null }],
    grants: [{ id: 'historic-grant', accountId: 'synthetic-a', status: 'REVOKED' }],
    exceptions: [{ id: 'original-exception', scope: 'HOUSEHOLD', expiresAt: null, grantedBy: 'synthetic-admin' }],
    cases: [] as any[], audits: [] as any[] };
  const db: any = {
    $queryRaw: vi.fn(async () => []), $transaction: async (fn: any) => fn(db),
    identityCluster: { findMany: async ({ where }: any) => where.authorityReviewRequired ? [state.root] : [], findUniqueOrThrow: async () => state.root },
    identityClusterMember: { findMany: async () => state.members },
    identityKey: { findMany: async () => state.keys }, trialGrant: { findMany: async () => state.grants },
    exceptionGrant: { findMany: async () => state.exceptions }, enforcementAction: { findMany: async () => [] },
    mmgPayerEvidence: { findMany: async () => [] }, user: { findUnique: async () => ({ tenantId: 'synthetic-tenant' }) },
    identityReviewCase: {
      upsert: async ({ create }: any) => { const row = state.cases.find(c => c.snapshotDigest === create.snapshotDigest); if (row) return row;
        const next = { id: `case-${state.cases.length}`, status: 'OPEN', ...create }; state.cases.push(next); return next; },
      findUniqueOrThrow: async ({ where }: any) => state.cases.find(c => c.id === where.id),
      update: vi.fn(async ({ where, data }: any) => Object.assign(state.cases.find(c => c.id === where.id), data)),
    },
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data; } },
  };
  return { state, db };
}
describe('bounded historical identity review preserves facts', () => {
  it('stages and acknowledges a complete named snapshot idempotently without changing original facts', async () => {
    const h = fixture(); const original = JSON.stringify([h.state.root, h.state.members, h.state.keys, h.state.grants, h.state.exceptions]);
    const { cases } = await stageIdentityReviewCases(h.db); const review = cases[0]!;
    expect(review.complete).toBe(true);
    expect((await stageIdentityReviewCases(h.db)).cases[0]!.id).toBe(review.id);
    const input = { caseId: review.id, expectedDigest: review.snapshotDigest, members: [{ accountId: 'synthetic-a', disposition: 'KEEP_REVIEW' as const }], adminId: 'synthetic-admin', note: 'Synthetic provenance remains unresolved' };
    expect((await retainIdentityReview(h.db, input)).status).toBe('RETAINED');
    await retainIdentityReview(h.db, input); expect(h.state.audits).toHaveLength(1);
    expect(JSON.stringify([h.state.root, h.state.members, h.state.keys, h.state.grants, h.state.exceptions])).toBe(original);
  });
  it.each(['key', 'grant', 'exception', 'member-list'])('rejects stale or incomplete reviewed %s without applying', async (change) => {
    const h = fixture(); const review = (await stageIdentityReviewCases(h.db)).cases[0]!;
    if (change === 'key') h.state.keys[0]!.valueHash = 'changed-key';
    if (change === 'grant') h.state.grants[0]!.status = 'ACTIVE';
    if (change === 'exception') h.state.exceptions[0]!.scope = 'FOUNDER_OVERRIDE';
    await expect(retainIdentityReview(h.db, { caseId: review.id, expectedDigest: review.snapshotDigest,
      members: change === 'member-list' ? [] : [{ accountId: 'synthetic-a', disposition: 'KEEP_REVIEW' }], adminId: 'synthetic-admin', note: 'Synthetic bounded review' })).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_STALE' });
    expect(h.db.identityReviewCase.update).not.toHaveBeenCalled(); expect(h.state.audits).toHaveLength(0);
  });
  it('overflow stays unresolved and refuses an apparent complete disposition', async () => {
    const h = fixture(); h.state.keys = Array.from({ length: 501 }, (_, i) => ({ ...h.state.keys[0]!, id: `key-${i}` }));
    const review = (await stageIdentityReviewCases(h.db)).cases[0]!; expect(review.complete).toBe(false);
    await expect(retainIdentityReview(h.db, { caseId: review.id, expectedDigest: review.snapshotDigest, members: [{ accountId: 'synthetic-a', disposition: 'KEEP_REVIEW' }], adminId: 'synthetic-admin', note: 'Synthetic incomplete review' })).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_STALE' });
    expect(h.state.grants[0]!.status).toBe('REVOKED'); expect(h.state.root.authorityReviewRequired).toBe(true);
  });
});
