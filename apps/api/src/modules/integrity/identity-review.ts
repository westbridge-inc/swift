import { bindTenantTransaction, rlsBindEnabled, systemPrismaClient } from '../../plugins/prisma';
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { runWithoutTenant } from '../../plugins/tenant-context';

type Db = PrismaClient | Prisma.TransactionClient;
export type IdentityAuthority =
  | { status: 'UNCLUSTERED'; clusterId: null; memberIds: string[] }
  | { status: 'RESOLVED'; clusterId: string; memberIds: string[] }
  | { status: 'REVIEW_REQUIRED'; clusterId: string; memberIds: string[]; reason: string };
export class IdentityReviewRequiredError extends AppError {
  constructor() { super(409, 'IDENTITY_REVIEW_REQUIRED', 'An identity record needs manual review before this new benefit or identity decision. Existing payments and entitlements are unchanged.'); }
}

/** Explicit authority, retaining historical membership for review. Callers must
 * choose how uncertainty affects their action; it is never an empty cluster. */
export async function identityAuthority(db: Db, accountId: string): Promise<IdentityAuthority> {
  const member = await db.identityClusterMember.findUnique({ where: { accountId }, select: { clusterId: true } });
  if (!member) return { status: 'UNCLUSTERED', clusterId: null, memberIds: [accountId] };
  let root = member.clusterId;
  const seen = new Set<string>();
  let review = false;
  for (let hops = 0; hops < 32; hops++) {
    if (seen.has(root)) return { status: 'REVIEW_REQUIRED', clusterId: root, memberIds: [accountId], reason: 'LINEAGE_CYCLE' };
    seen.add(root);
    const row = await db.identityCluster.findUnique({ where: { id: root }, select: { mergedIntoId: true, authorityReviewRequired: true } });
    if (!row) return { status: 'REVIEW_REQUIRED', clusterId: root, memberIds: [accountId], reason: 'MISSING_ROOT' };
    review ||= row.authorityReviewRequired;
    if (row.mergedIntoId) { root = row.mergedIntoId; continue; }
    const members = await db.identityClusterMember.findMany({ where: { clusterId: root }, select: { accountId: true }, take: 501, orderBy: { accountId: 'asc' } });
    const memberIds = members.map((m) => m.accountId);
    if (members.length > 500 || !memberIds.includes(accountId)) return { status: 'REVIEW_REQUIRED', clusterId: root, memberIds, reason: 'INCOMPLETE_MEMBERSHIP' };
    return review ? { status: 'REVIEW_REQUIRED', clusterId: root, memberIds, reason: 'LEGACY_AUTHORITY' }
      : { status: 'RESOLVED', clusterId: root, memberIds };
  }
  return { status: 'REVIEW_REQUIRED', clusterId: root, memberIds: [accountId], reason: 'LINEAGE_LIMIT' };
}

export async function requireIdentityAuthority(db: Db, accountId: string): Promise<IdentityAuthority> {
  const resolution = await identityAuthority(db, accountId);
  if (resolution.status === 'REVIEW_REQUIRED') throw new IdentityReviewRequiredError();
  return resolution;
}

/** Common lock for capture, review and new trial/promo/exception writes. */
export async function lockIdentityAuthority(tx: Prisma.TransactionClient): Promise<void> {
  await bindTenantTransaction(tx);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('identity-authority-v1', 0))::text AS locked`;
}

/** Start system work on one connection; scoped delegates must not escape an
 * interactive transaction by rerouting individual queries to a root client. */
export async function identityTransaction<T>(prisma: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return runWithoutTenant(() => {
    const client = rlsBindEnabled() ? systemPrismaClient() : prisma;
    if (!client) throw new AppError(503, 'IDENTITY_SYSTEM_DATABASE_UNAVAILABLE', 'Identity review is temporarily unavailable.');
    return client.$transaction(work);
  });
}

const LIMIT = 500;
async function reviewSnapshot(tx: Prisma.TransactionClient, clusterId: string) {
  const root = await tx.identityCluster.findUniqueOrThrow({ where: { id: clusterId } });
  const ancestors: typeof root[] = [];
  let frontier = [clusterId];
  let lineageComplete = true;
  const seen = new Set(frontier);
  for (let depth = 0; frontier.length && depth < 32; depth++) {
    const level = await tx.identityCluster.findMany({ where: { mergedIntoId: { in: frontier } }, orderBy: { id: 'asc' }, take: LIMIT + 1 });
    if (level.some((row) => seen.has(row.id)) || ancestors.length + level.length > LIMIT) { lineageComplete = false; break; }
    ancestors.push(...level);
    frontier = level.map((row) => row.id);
    frontier.forEach((id) => seen.add(id));
  }
  if (frontier.length) lineageComplete = false;
  ancestors.sort((a, b) => a.id.localeCompare(b.id));
  const historicalClusters = [clusterId, ...ancestors.map((row) => row.id)];
  const members = await tx.identityClusterMember.findMany({ where: { clusterId: { in: historicalClusters } }, orderBy: { accountId: 'asc' }, take: LIMIT + 1 });
  const ids = members.map((m) => m.accountId);
  // No names, phones, payloads or document contents. Keys are already hashed.
  const keys = await tx.identityKey.findMany({ where: { accountId: { in: ids } }, orderBy: { id: 'asc' }, take: LIMIT + 1 });
  const grants = await tx.trialGrant.findMany({ where: { clusterId: { in: historicalClusters } }, orderBy: { id: 'asc' }, take: LIMIT + 1 });
  const exceptions = await tx.exceptionGrant.findMany({ where: { clusterId: { in: historicalClusters } }, select: { id: true, scope: true, expiresAt: true, grantedBy: true }, orderBy: { id: 'asc' }, take: LIMIT + 1 });
  const actions = await tx.enforcementAction.findMany({ where: { OR: [{ clusterId: { in: historicalClusters } }, { accountId: { in: ids } }] },
    select: { id: true, accountId: true, clusterId: true, level: true, reasonCode: true, appeal: true }, orderBy: { id: 'asc' }, take: LIMIT + 1 });
  const payerEvidence = await tx.mmgPayerEvidence.findMany({ where: { accountId: { in: ids } }, orderBy: { id: 'asc' }, take: LIMIT + 1 });
  const complete = lineageComplete && !root.mergedIntoId && members.length > 0
    && [members, keys, grants, exceptions, actions, payerEvidence, ancestors].every((rows) => rows.length <= LIMIT);
  const snapshot = JSON.parse(JSON.stringify({ root, members, keys, grants, exceptions, actions, payerEvidence, ancestors })) as Prisma.InputJsonValue;
  return { complete, snapshot, digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), ids };
}

/** Resumable bounded case creation; never splits, deletes or regrants. */
export async function stageIdentityReviewCases(prisma: PrismaClient, afterId?: string, limit = 25) {
  return identityTransaction(prisma, async (tx) => {
    await lockIdentityAuthority(tx);
    const roots = await tx.identityCluster.findMany({ where: { authorityReviewRequired: true, mergedIntoId: null,
      ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: Math.max(1, Math.min(limit, 25)) });
    const cases = [];
    for (const root of roots) {
      const snap = await reviewSnapshot(tx, root.id);
      const account = snap.ids[0] ? await tx.user.findUnique({ where: { id: snap.ids[0] }, select: { tenantId: true } }) : null;
      if (!account) continue; // still flagged, never certified from an incomplete scan
      cases.push(await tx.identityReviewCase.upsert({ where: { clusterId_snapshotDigest: { clusterId: root.id, snapshotDigest: snap.digest } },
        create: { tenantId: account.tenantId, clusterId: root.id, snapshotDigest: snap.digest, snapshot: snap.snapshot, complete: snap.complete }, update: {} }));
    }
    return { cases, nextCursor: roots.at(-1)?.id ?? null };
  });
}

/** The initial repair can only retain review. No supported payer contract can
 * justify a split, automatic restoration, refund or clearing ambiguous history.
 * A future resolving disposition requires independently proven lineage and its
 * own reviewed contract. A human acknowledgment is durable and snapshot-bound. */
export async function retainIdentityReview(prisma: PrismaClient, input: {
  caseId: string; expectedDigest: string; members: Array<{ accountId: string; disposition: 'KEEP_REVIEW' }>;
  adminId: string; note: string;
}) {
  return identityTransaction(prisma, async (tx) => {
    await lockIdentityAuthority(tx);
    const review = await tx.identityReviewCase.findUniqueOrThrow({ where: { id: input.caseId } });
    const snap = await reviewSnapshot(tx, review.clusterId);
    const ids = input.members.map((m) => m.accountId).sort();
    if (!review.complete || !snap.complete || review.snapshotDigest !== input.expectedDigest || snap.digest !== input.expectedDigest
        || JSON.stringify(ids) !== JSON.stringify([...snap.ids].sort()) || input.members.some((m) => m.disposition !== 'KEEP_REVIEW')
        || input.note.trim().length < 8) throw new AppError(409, 'IDENTITY_REVIEW_STALE', 'The complete reviewed snapshot and every member disposition must still match.');
    if (review.status === 'RETAINED') return review;
    const updated = await tx.identityReviewCase.update({ where: { id: review.id }, data: {
      status: 'RETAINED', disposition: 'KEEP_REVIEW', reviewedBy: input.adminId, reviewedAt: new Date(), reviewNote: input.note,
    } });
    await tx.auditLog.create({ data: { userId: input.adminId, action: 'IDENTITY_REVIEW_RETAINED', entity: 'IdentityReviewCase', entityId: review.id,
      changes: { snapshotDigest: input.expectedDigest, members: input.members, disposition: 'KEEP_REVIEW' } } });
    return updated;
  });
}
