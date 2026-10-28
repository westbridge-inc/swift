import type { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// [SEC-PII · money/trust scan 28 Oct 2026] A DOCUMENT UNDER INVESTIGATION WAITS FOR THE INVESTIGATION.
//
// A person's own erasure (POST /verification/dsar/documents/erase, and account deletion) refused only a
// legal hold, an AML record or an approved licence backing a live relationship. A document whose fraud
// suspicion waits on a second reviewer has no hold yet (the hold is placed when the second reviewer
// confirms), so it could be destroyed before that review: the evidence gone before anyone decided.
//
// A document is under investigation while any of these is open:
//   - a review case on it in the SECOND_REVIEW queue (a fraud-class suspicion waiting for a second person);
//   - a fraud case on the person, or linking them, whose legal hold is not released (or that has none);
//   - an identity review of the person's identity cluster (or a cluster it was merged into).
// Erasure refuses it with its own ground (OPEN_INVESTIGATION) and the plain words below, and keeps it until
// the review ends; then the person's erasure (or, after account deletion, the retention clock) takes it.
// Everything else about erasure is unchanged. The check is made again under the person's row lock at the
// moment of destruction, so a review opened in between still keeps the document.
// ---------------------------------------------------------------------------

export const OPEN_INVESTIGATION_TEXT =
  'This document is part of a review that is still open. It is kept until the review ends, and your request is completed then.';

type Db = PrismaClient | Prisma.TransactionClient;
const MERGE_DEPTH = 32;

/** The person's identity cluster and every cluster it was merged into (the resolver's own direction). */
async function clusterChain(db: Db, userId: string): Promise<string[]> {
  const member = await db.identityClusterMember.findUnique({ where: { accountId: userId }, select: { clusterId: true } });
  const chain: string[] = [];
  let next: string | null = member?.clusterId ?? null;
  while (next && !chain.includes(next) && chain.length < MERGE_DEPTH) {
    chain.push(next);
    const cluster: { mergedIntoId: string | null } | null = await db.identityCluster.findUnique({ where: { id: next }, select: { mergedIntoId: true } });
    next = cluster?.mergedIntoId ?? null;
  }
  return chain;
}

/** Whether the PERSON is under an open fraud case or identity review (every document of theirs waits). */
export async function personUnderInvestigation(db: Db, userId: string): Promise<boolean> {
  // The subject, or an account the confirmed case links to it (held for a founder decision, with no hold of its
  // own: the census abandoned-application.ts uses). Open while its legal hold is not released, or it has none.
  const fraud = await db.fraudCase.count({
    where: {
      AND: [
        { OR: [{ subjectUserId: userId }, { linkedAccountIds: { array_contains: [userId] } }] },
        { OR: [{ legalHoldId: null }, { legalHold: { releasedAt: null } }] },
      ],
    },
  });
  if (fraud > 0) return true;
  const clusters = await clusterChain(db, userId);
  if (clusters.length === 0) return false;
  return (await db.identityReviewCase.count({ where: { clusterId: { in: clusters }, status: 'OPEN' } })) > 0;
}

/** The person's documents (of those named) that wait on an open second review. */
export async function documentsInSecondReview(db: Db, documentIds: readonly string[]): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const open = await db.reviewCase.findMany({
    where: { submissionId: { in: [...documentIds] }, queue: 'SECOND_REVIEW', closedAt: null }, select: { submissionId: true },
  });
  return new Set(open.map((c) => c.submissionId));
}

/** One document: is it under investigation right now? (Called again under the person's row lock.) */
export async function documentUnderInvestigation(db: Db, userId: string, documentId: string): Promise<boolean> {
  if ((await documentsInSecondReview(db, [documentId])).size > 0) return true;
  return personUnderInvestigation(db, userId);
}
