import type { UserRole } from '@prisma/client';

/**
 * [NO-DEAD-ENDS · owner, 6 Oct] "Resubmit the document rejected rather than
 * restart the application." The applicant already can: a rejected document
 * re-opens on its own card, with the reviewer's reason, and the new upload is
 * a fresh PENDING row while every other document keeps its verdict. What the
 * reviewer could not see is that the upload IS a re-submission: the Review
 * Center queue showed it like any first upload, without the earlier verdict or
 * the reason the applicant was asked to fix.
 *
 * For each queued document this finds the applicant's most recent EARLIER
 * decided document of the same type, so the queue row can say "Re-submitted
 * after rejection: <reason>" (or "Renewal"). Only rows of applicants already on
 * the page are read, through the caller's tenant-scoped client.
 */
export type PreviousDecisionKind = 'RESUBMITTED_AFTER_REJECTION' | 'RENEWAL';

export interface PreviousDecision {
  documentId: string;
  kind: PreviousDecisionKind;
  status: 'REJECTED' | 'EXPIRED' | 'APPROVED';
  /** The reviewer's own words to the applicant (null when none were recorded). */
  reviewNote: string | null;
  decidedAt: Date | null;
  submittedAt: Date;
}

export interface QueuedDocument { id: string; userId: string; role: UserRole; subjectId: string | null; docType: string; createdAt: Date }
export interface EarlierDocument extends QueuedDocument {
  status: string;
  reviewNote: string | null; reviewedAt: Date | null; createdAt: Date;
}

/** The statuses that are a decision a later upload answers. */
export const DECIDED_STATUSES = ['REJECTED', 'EXPIRED', 'APPROVED'] as const;

/** The where-clause for the earlier documents of the queued ones (same applicant, same type, uploaded before). */
export function earlierDocumentsWhere(queued: readonly QueuedDocument[]) {
  return {
    status: { in: [...DECIDED_STATUSES] },
    OR: queued.map((doc) => ({ userId: doc.userId, role: doc.role, subjectId: doc.subjectId, docType: doc.docType, createdAt: { lt: doc.createdAt } })),
  };
}

/** For each queued document, the latest earlier decision on the same applicant, role, subject and document type. */
export function previousDecisions(queued: readonly QueuedDocument[], earlier: readonly EarlierDocument[]): Map<string, PreviousDecision> {
  const newestFirst = [...earlier].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const found = new Map<string, PreviousDecision>();
  for (const doc of queued) {
    const prior = newestFirst.find((e) => e.userId === doc.userId && e.role === doc.role && e.subjectId === doc.subjectId && e.docType === doc.docType
      && e.id !== doc.id && e.createdAt.getTime() < doc.createdAt.getTime()
      && (DECIDED_STATUSES as readonly string[]).includes(e.status));
    if (!prior) continue;
    const status = prior.status as PreviousDecision['status'];
    found.set(doc.id, {
      documentId: prior.id,
      kind: status === 'REJECTED' ? 'RESUBMITTED_AFTER_REJECTION' : 'RENEWAL',
      status,
      reviewNote: prior.reviewNote,
      decidedAt: prior.reviewedAt,
      submittedAt: prior.createdAt,
    });
  }
  return found;
}

/**
 * The queue rows with `previousDecision` attached. The lookup is a courtesy to
 * the reviewer: if it fails, the queue still answers, every row reads
 * `previousDecision: null`, and the failure is reported. An empty page reads
 * nothing.
 */
export async function withPreviousDecisions<D extends QueuedDocument>(
  documents: readonly D[],
  readEarlier: (where: ReturnType<typeof earlierDocumentsWhere>) => Promise<EarlierDocument[]>,
  onLookupFailed: (error: unknown) => void,
): Promise<Array<D & { previousDecision: PreviousDecision | null }>> {
  let previous = new Map<string, PreviousDecision>();
  if (documents.length) {
    try {
      previous = previousDecisions(documents, await readEarlier(earlierDocumentsWhere(documents)));
    } catch (error) {
      onLookupFailed(error);
    }
  }
  return documents.map((doc) => ({ ...doc, previousDecision: previous.get(doc.id) ?? null }));
}
