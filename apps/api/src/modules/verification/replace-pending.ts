/**
 * [Owner request 8 Oct 2026, built under the 11 Oct brief] REPLACE A DOCUMENT WHILE IT WAITS FOR REVIEW.
 *
 * "I can't change a submitted document if I accidentally sent the wrong one." A new upload of the same
 * document (same account, role and type) while an earlier copy is still waiting for a reviewer replaces
 * that copy:
 *  - the earlier copy becomes SUPERSEDED — kept for audit, never deleted (its file, ledger and history
 *    stay; retention rules apply to it as to any superseded submission) — and can no longer be decided;
 *  - its open review case closes, so the queue shows only the newest copy, which gets its own fresh case
 *    (a reviewer who had claimed the old copy is told it was replaced if they try to decide it);
 *  - an APPROVED document stays locked: renewal rules are unchanged (submitDocument still refuses a new
 *    copy of an approved, current document outside the renewal window).
 * A new copy that is rejected straight away (an unreadable or refused upload) replaces nothing, so a
 * good copy already waiting is never lost to a bad one. A copy under a legal hold is frozen and stays.
 */
import type { Prisma } from '@prisma/client';
import { hopDocState } from './doc-state';

type Tx = Prisma.TransactionClient;

/** The states a copy rests in while it waits for a person. */
export const AWAITING_REVIEW_STATES = ['REVIEW_QUEUED', 'IN_REVIEW', 'INFO_REQUESTED'] as const;
export const REPLACED_NOTE = 'REPLACED: the applicant uploaded a newer copy before review';
export const DOCUMENT_REPLACED = 'DOCUMENT_REPLACED';

/** Supersedes every earlier copy still awaiting review; returns their ids. Runs in the upload's transaction. */
export async function supersedeAwaitingCopies(tx: Tx, doc: { id: string; userId: string; role: string; docType: string }): Promise<string[]> {
  // Two uploads of the same document at once: the second waits for the first, then replaces it.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`document-replace:${doc.userId}:${doc.role}:${doc.docType}`}))::text AS locked`;
  const earlier = await tx.verificationDocument.findMany({
    where: { userId: doc.userId, role: doc.role as never, docType: doc.docType, id: { not: doc.id }, state: { in: [...AWAITING_REVIEW_STATES] }, legalHoldId: null },
    select: { id: true },
  });
  if (earlier.length === 0) return [];
  const ids = earlier.map((row) => row.id);
  // Lock order: a review case BEFORE its document — the order the reviewer paths take.
  await tx.$queryRaw`SELECT id FROM review_case WHERE "submissionId" = ANY(${ids}) ORDER BY id FOR UPDATE`;
  const replaced: string[] = [];
  for (const id of ids) {
    // SUPERSEDED has no legacy status of its own; EXPIRED keeps every status-only reader from treating
    // the replaced copy as waiting, approved or rejected.
    if (await hopDocState(tx, { id, userId: doc.userId }, [...AWAITING_REVIEW_STATES], 'SUPERSEDED', { status: 'EXPIRED', reviewNote: REPLACED_NOTE })) replaced.push(id);
  }
  if (replaced.length > 0) {
    await tx.reviewCase.updateMany({ where: { submissionId: { in: replaced }, closedAt: null }, data: { closedAt: new Date() } });
  }
  return replaced;
}
