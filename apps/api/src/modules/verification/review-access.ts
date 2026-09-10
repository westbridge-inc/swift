import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient, type ReviewQueue } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { hasPrivilegedSessionAssurance } from '../auth/session-assurance';
import { capabilitiesOf, holdsCapability } from '../admin/admin-authority';
import { assertNotRecused } from './recusal';

export const REVIEW_RENDER_GRANT_TTL_MS = 5 * 60 * 1000;

type ReviewTx = Prisma.TransactionClient;

export interface ClaimedReviewAccess {
  document: {
    id: string;
    tenantId: string;
    userId: string;
    fileUrl: string;
    docType: string;
    status: string;
    state: string | null;
    storageProvenance: string;
    storagePurgeRequestedAt: Date | null;
    purgedAt: Date | null;
    imagePurgedAt: Date | null;
  };
  reviewCase: {
    id: string;
    tenantId: string;
    queue: ReviewQueue;
    assignedTo: string;
    assignedAt: Date;
    assignmentEpoch: string;
    createdAt: Date;
  };
}

interface LockedGrant {
  id: string;
  tokenHash: string;
  tenantId: string;
  documentId: string;
  caseId: string;
  reviewerId: string;
  sessionId: string;
  assignmentAt: Date;
  assignmentEpoch: string;
  storageLocationId: string;
  objectKeyHash: string;
  objectVersion: string;
  objectEncrypted: boolean;
  objectSha256: string;
  expiresAt: Date;
  reservedAt: Date | null;
  fetchedAt: Date | null;
  acknowledgedAt: Date | null;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

export interface ReviewObjectIdentity {
  storageLocationId: string;
  providerKey: string;
  objectVersion: string;
  encrypted: boolean;
  sha256: string;
}

type ReviewGrantAuthorityInput = {
  tenantId: string;
  documentId: string;
  reviewerId: string;
  sessionId: string;
};

function assertGrantAuthority(
  grant: LockedGrant | undefined,
  input: ReviewGrantAuthorityInput,
): asserts grant is LockedGrant {
  if (!grant
    || grant.documentId !== input.documentId
    || grant.reviewerId !== input.reviewerId
    || grant.sessionId !== input.sessionId) {
    throw new AppError(403, 'REVIEW_GRANT_INVALID', 'This review grant is invalid for the current session.');
  }
}

export function reviewGrantTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function reviewObjectKeyHash(providerKey: string): string {
  return createHash('sha256').update(providerKey, 'utf8').digest('hex');
}

export function assertDocumentReviewable(document: ClaimedReviewAccess['document']): void {
  if (document.purgedAt || document.imagePurgedAt || document.storagePurgeRequestedAt) {
    throw new AppError(410, 'DOCUMENT_PURGED', 'This document is no longer available for human review.');
  }
  if (document.status !== 'PENDING' || document.state !== 'IN_REVIEW') {
    throw new AppError(409, 'DOCUMENT_NOT_REVIEWABLE', 'This document is not in the human-review state.');
  }
  if (document.storageProvenance !== 'VERIFIED' || !document.fileUrl) {
    throw new AppError(409, 'DOCUMENT_OWNERSHIP_INVALID', 'This document has no verified storage authority for human review.');
  }
}

/**
 * Lock and re-evaluate the complete authority for a sensitive review read.
 * The lock order matches document decisions: identity graph, sorted users,
 * document, then case. Duplicate open cases are an integrity failure, never a
 * choice made by array order.
 */
export async function lockClaimedReviewAccess(
  tx: ReviewTx,
  input: {
    tenantId: string;
    documentId: string;
    reviewerId: string;
    sessionId: string;
    requiredCapability?: string;
    expectedCaseId?: string;
    expectedAssignmentEpoch?: string;
    now?: Date;
  },
): Promise<ClaimedReviewAccess> {
  const candidate = await tx.verificationDocument.findFirst({
    where: { id: input.documentId, tenantId: input.tenantId },
    select: { userId: true },
  });
  if (!candidate) throw new NotFoundError('VerificationDocument', input.documentId);

  await tx.$queryRaw<Array<{ locked: string }>>`
    SELECT pg_advisory_xact_lock(hashtextextended('identity-graph-membership', 0))::text AS locked
  `;
  const lockIds = [...new Set([candidate.userId, input.reviewerId])].sort();
  const users = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "users"
    WHERE "tenantId" = ${input.tenantId}
      AND "id" IN (${Prisma.join(lockIds)})
    ORDER BY "id"
    FOR UPDATE
  `);
  if (!users.some((user) => user.id === candidate.userId)) {
    throw new NotFoundError('VerificationDocument', input.documentId);
  }
  if (!users.some((user) => user.id === input.reviewerId)) {
    throw new AppError(403, 'REVIEWER_AUTHORITY_REVOKED', 'This reviewer account is no longer available.');
  }

  const reviewer = await tx.user.findUnique({
    where: { id: input.reviewerId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      activeRole: true,
      roles: true,
      admin: { select: { permissions: true } },
    },
  });
  const adminRole = reviewer?.activeRole === 'ADMIN' || reviewer?.activeRole === 'SUPER_ADMIN';
  if (
    !reviewer
    || reviewer.tenantId !== input.tenantId
    || reviewer.status !== 'ACTIVE'
    || !adminRole
    || !reviewer.roles.includes(reviewer.activeRole)
  ) {
    throw new AppError(403, 'REVIEWER_AUTHORITY_REVOKED', 'This reviewer no longer has active admin authority.');
  }
  await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT "userId" FROM "admins" WHERE "userId" = ${input.reviewerId} FOR UPDATE
  `);
  const permissions = (await tx.admin.findUnique({
    where: { userId: input.reviewerId },
    select: { permissions: true },
  }))?.permissions ?? null;
  const requiredCapability = input.requiredCapability ?? 'verification.document.read';
  if (!holdsCapability(capabilitiesOf({ role: reviewer.activeRole, permissions }), requiredCapability)) {
    throw new AppError(403, 'REVIEWER_CAPABILITY_REVOKED', `This review requires the ${requiredCapability} capability.`);
  }
  const sessions = await tx.$queryRaw<Array<{
    id: string;
    userId: string;
    authMethod: string;
    expiresAt: Date;
  }>>(Prisma.sql`
    SELECT "id", "userId", "authMethod"::text AS "authMethod", "expiresAt"
    FROM "sessions"
    WHERE "id" = ${input.sessionId}
    FOR UPDATE
  `);
  const session = sessions[0];
  if (
    !session
    || session.userId !== input.reviewerId
    || session.expiresAt.getTime() <= (input.now ?? new Date()).getTime()
    || !hasPrivilegedSessionAssurance(session.authMethod as 'LEGACY' | 'PASSWORD' | 'OTP')
  ) {
    throw new AppError(401, 'REVIEW_SESSION_REVOKED', 'This reviewer session is no longer active.');
  }

  const documents = await tx.$queryRaw<ClaimedReviewAccess['document'][]>(Prisma.sql`
    SELECT "id", "tenantId", "userId", "fileUrl", "docType", "status"::text AS "status",
           "state"::text AS "state", "storageProvenance"::text AS "storageProvenance",
           "storagePurgeRequestedAt", "purgedAt", "imagePurgedAt"
    FROM "verification_documents"
    WHERE "id" = ${input.documentId} AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `);
  const document = documents[0];
  if (!document) throw new NotFoundError('VerificationDocument', input.documentId);
  if (document.userId !== candidate.userId) {
    throw new AppError(409, 'DOCUMENT_AUTHORITY_CHANGED', 'The document owner changed before review access was locked.');
  }
  assertDocumentReviewable(document);

  const cases = await tx.$queryRaw<Array<{
    id: string;
    tenantId: string;
    queue: ReviewQueue;
    assignedTo: string | null;
    assignedAt: Date | null;
    assignmentEpoch: string | null;
    createdAt: Date;
  }>>(Prisma.sql`
    SELECT "id", "tenantId", "queue"::text AS "queue", "assignedTo", "assignedAt", "assignmentEpoch", "createdAt"
    FROM "review_case"
    WHERE "submissionId" = ${input.documentId}
      AND "tenantId" = ${input.tenantId}
      AND "closedAt" IS NULL
    ORDER BY "createdAt" DESC, "id" DESC
    FOR UPDATE
  `);
  if (cases.length === 0) {
    throw new AppError(409, 'REVIEW_CASE_REQUIRED', 'This document has no open review case.');
  }
  if (cases.length !== 1) {
    throw new AppError(409, 'REVIEW_CASE_INTEGRITY', 'This document has conflicting open review cases.');
  }
  const reviewCase = cases[0]!;
  if (!reviewCase.assignedTo || !reviewCase.assignedAt || !reviewCase.assignmentEpoch) {
    throw new AppError(409, 'CASE_CLAIM_REQUIRED', 'Claim this review case before opening sensitive evidence.');
  }
  if (reviewCase.assignedTo !== input.reviewerId) {
    throw new AppError(409, 'CASE_CLAIMED', 'Another reviewer holds this case.');
  }
  if (input.expectedCaseId && reviewCase.id !== input.expectedCaseId) {
    throw new AppError(409, 'REVIEW_GRANT_STALE', 'The review case changed; reopen the document.');
  }
  if (input.expectedAssignmentEpoch
    && reviewCase.assignmentEpoch !== input.expectedAssignmentEpoch) {
    throw new AppError(409, 'REVIEW_GRANT_STALE', 'The case assignment changed; reopen the document.');
  }
  await assertNotRecused(tx as unknown as PrismaClient, input.reviewerId, document.userId);

  return {
    document,
    reviewCase: {
      ...reviewCase,
      assignedTo: reviewCase.assignedTo,
      assignedAt: reviewCase.assignedAt,
      assignmentEpoch: reviewCase.assignmentEpoch,
    },
  };
}

export async function createReviewRenderGrant(
  tx: ReviewTx,
  input: {
    access: ClaimedReviewAccess;
    reviewerId: string;
    sessionId: string;
    object: ReviewObjectIdentity;
    now?: Date;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + REVIEW_RENDER_GRANT_TTL_MS);
  const token = randomBytes(32).toString('base64url');
  await tx.reviewRenderGrant.create({
    data: {
      tokenHash: reviewGrantTokenHash(token),
      tenantId: input.access.document.tenantId,
      documentId: input.access.document.id,
      caseId: input.access.reviewCase.id,
      reviewerId: input.reviewerId,
      sessionId: input.sessionId,
      assignmentAt: input.access.reviewCase.assignedAt,
      assignmentEpoch: input.access.reviewCase.assignmentEpoch,
      storageLocationId: input.object.storageLocationId,
      objectKeyHash: reviewObjectKeyHash(input.object.providerKey),
      objectVersion: input.object.objectVersion,
      objectEncrypted: input.object.encrypted,
      objectSha256: input.object.sha256.toLowerCase(),
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export async function lockReviewRenderGrant(
  tx: ReviewTx,
  input: {
    token: string;
    tenantId: string;
    documentId: string;
    reviewerId: string;
    sessionId: string;
    requiredCapability?: string;
    now?: Date;
  },
): Promise<{ grant: LockedGrant; access: ClaimedReviewAccess }> {
  // First read is deliberately non-locking. Every review path takes the global
  // identity/user/document/case locks before this grant-row lock; locking the
  // grant first here would invert the decision path and permit a deadlock.
  const candidates = await tx.$queryRaw<LockedGrant[]>(Prisma.sql`
    SELECT "id", "tokenHash", "tenantId", "documentId", "caseId", "reviewerId", "sessionId",
           "assignmentAt", "assignmentEpoch", "storageLocationId", "objectKeyHash", "objectVersion",
           "objectEncrypted", "objectSha256", "expiresAt",
           "reservedAt", "fetchedAt", "acknowledgedAt", "consumedAt", "revokedAt"
    FROM "review_render_grants"
    WHERE "tokenHash" = ${reviewGrantTokenHash(input.token)}
      AND "tenantId" = ${input.tenantId}
  `);
  const candidate = candidates[0];
  assertGrantAuthority(candidate, input);
  const access = await lockClaimedReviewAccess(tx, {
    tenantId: input.tenantId,
    documentId: input.documentId,
    reviewerId: input.reviewerId,
    sessionId: input.sessionId,
    requiredCapability: input.requiredCapability,
    expectedCaseId: candidate.caseId,
    expectedAssignmentEpoch: candidate.assignmentEpoch,
    now: input.now,
  });

  const rows = await tx.$queryRaw<LockedGrant[]>(Prisma.sql`
    SELECT "id", "tokenHash", "tenantId", "documentId", "caseId", "reviewerId", "sessionId",
           "assignmentAt", "assignmentEpoch", "storageLocationId", "objectKeyHash", "objectVersion",
           "objectEncrypted", "objectSha256", "expiresAt",
           "reservedAt", "fetchedAt", "acknowledgedAt", "consumedAt", "revokedAt"
    FROM "review_render_grants"
    WHERE "tokenHash" = ${reviewGrantTokenHash(input.token)}
      AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `);
  const grant = rows[0];
  assertGrantAuthority(grant, input);
  if (grant.caseId !== access.reviewCase.id
    || grant.assignmentEpoch !== access.reviewCase.assignmentEpoch) {
    throw new AppError(409, 'REVIEW_GRANT_STALE', 'The case assignment changed; reopen the document.');
  }
  if (grant.expiresAt.getTime() <= (input.now ?? new Date()).getTime()) {
    throw new AppError(410, 'REVIEW_GRANT_EXPIRED', 'This review grant expired; reopen the document.');
  }
  if (grant.consumedAt) {
    throw new AppError(409, 'REVIEW_GRANT_CONSUMED', 'This review grant was already used for a decision.');
  }
  if (grant.revokedAt) {
    throw new AppError(409, 'REVIEW_GRANT_REVOKED', 'This review grant is no longer valid for the case assignment.');
  }
  return { grant, access };
}

export function assertGrantObjectIdentity(grant: LockedGrant, object: ReviewObjectIdentity): void {
  if (grant.storageLocationId !== object.storageLocationId
    || grant.objectVersion !== object.objectVersion
    || grant.objectKeyHash !== reviewObjectKeyHash(object.providerKey)
    || grant.objectEncrypted !== object.encrypted
    || grant.objectSha256 !== object.sha256.toLowerCase()) {
    throw new AppError(409, 'REVIEW_GRANT_STALE', 'The stored document generation changed; reopen the document.');
  }
}

export async function acknowledgeReviewRenderGrant(
  tx: ReviewTx,
  input: {
    token: string;
    tenantId: string;
    documentId: string;
    reviewerId: string;
    sessionId: string;
  },
): Promise<void> {
  const { grant } = await lockReviewRenderGrant(tx, input);
  if (!grant.fetchedAt) {
    throw new AppError(409, 'REVIEW_FETCH_REQUIRED', 'Fetch the document before acknowledging browser rendering.');
  }
  if (grant.acknowledgedAt) return; // safe same-session retry
  const won = await tx.reviewRenderGrant.updateMany({
    where: { id: grant.id, fetchedAt: { not: null }, acknowledgedAt: null, consumedAt: null, revokedAt: null },
    data: { acknowledgedAt: new Date() },
  });
  if (won.count !== 1) {
    throw new AppError(409, 'REVIEW_GRANT_STALE', 'The render acknowledgement is no longer current.');
  }
}
