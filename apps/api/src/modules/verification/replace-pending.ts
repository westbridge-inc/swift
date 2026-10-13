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
import { AppError } from '../../utils/errors';

type Tx = Prisma.TransactionClient;

/** The states a copy rests in while it waits for a person. */
export const AWAITING_REVIEW_STATES = ['REVIEW_QUEUED', 'IN_REVIEW', 'INFO_REQUESTED'] as const;
export const REPLACED_NOTE = 'REPLACED: the applicant uploaded a newer copy before review';
export const DOCUMENT_REPLACED = 'DOCUMENT_REPLACED';
export const DOCUMENT_UNDER_SECOND_CHECK = 'DOCUMENT_UNDER_SECOND_CHECK';
/** Review queues that mean suspicion awaiting a different reviewer (DOC-1 §24.2). */
const SECOND_CHECK_QUEUES = ['SECOND_REVIEW', 'ESCALATED'] as const;

/** The note a replaced copy carries, naming the copy that replaced it — so "replaced" belongs to that copy only. */
export function replacedNoteFor(replacementId: string): string {
  return `${REPLACED_NOTE} (${replacementId})`;
}
export function isReplacedNote(note: string | null | undefined): boolean {
  return !!note && note.startsWith(REPLACED_NOTE);
}

type Copy = { id: string; userId: string; role: string; docType: string; createdAt: Date; state?: string | null };
/** Which of two copies is newer: later createdAt, then the larger id (a stable tie-break). */
const newerThan = (a: { id: string; createdAt: Date }, b: { id: string; createdAt: Date }) =>
  a.createdAt.getTime() > b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id > b.id);

export interface ReplaceOutcome {
  /** Earlier copies this upload replaced. */
  readonly replaced: string[];
  /** The upload itself turned out older than a copy already waiting (two uploads raced), so it was replaced instead. */
  readonly selfReplaced: boolean;
}

/**
 * Supersedes every OLDER copy still awaiting review, in the upload's transaction. If a NEWER copy is
 * already waiting (two uploads raced and the newer one committed first), the newest copy still wins:
 * this upload, if it is itself waiting, is the one replaced.
 */
export async function supersedeAwaitingCopies(tx: Tx, doc: Copy): Promise<ReplaceOutcome> {
  // Two uploads of the same document at once: the second waits for the first, then decides.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`document-replace:${doc.userId}:${doc.role}:${doc.docType}`}))::text AS locked`;
  // [Opus 12 Oct · DOC-1 §24.2] A copy under a second check — a reviewer escalated it, or intake routed it there
  // because its file matched another account — is suspicion awaiting a DIFFERENT reviewer. A new upload must
  // never wipe it (its confirmation opens the fraud case and the legal hold), so the upload is refused and the
  // escalated copy stays exactly as it is. The words do not say why, as the applicant is never told of suspicion.
  const underSecondCheck = await tx.reviewCase.count({ where: {
    closedAt: null, queue: { in: [...SECOND_CHECK_QUEUES] },
    submissionId: { in: (await tx.verificationDocument.findMany({
      where: { userId: doc.userId, role: doc.role as never, docType: doc.docType, id: { not: doc.id }, state: { in: [...AWAITING_REVIEW_STATES] } },
      select: { id: true },
    })).map((row) => row.id) },
  } });
  if (underSecondCheck > 0) {
    throw new AppError(409, DOCUMENT_UNDER_SECOND_CHECK, 'We are still checking the copy you sent. You can send a new one once that check is finished.');
  }
  const others = await tx.verificationDocument.findMany({
    where: { userId: doc.userId, role: doc.role as never, docType: doc.docType, id: { not: doc.id }, state: { in: [...AWAITING_REVIEW_STATES] }, legalHoldId: null },
    select: { id: true, createdAt: true },
  });
  const newest = others.find((other) => newerThan(other, doc));
  const selfAwaiting = (AWAITING_REVIEW_STATES as readonly string[]).includes(doc.state ?? '');
  if (newest && selfAwaiting) {
    const replaced = await supersede(tx, doc.userId, [doc.id], newest.id);
    return { replaced: [], selfReplaced: replaced.length > 0 };
  }
  const older = others.filter((other) => !newerThan(other, doc)).map((other) => other.id);
  return { replaced: await supersede(tx, doc.userId, older, doc.id), selfReplaced: false };
}

async function supersede(tx: Tx, userId: string, ids: string[], replacementId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  // Lock the cases being closed. Deadlock safety rests on the per-document advisory lock above and on
  // the identity-authority lock every submission and decision takes first, not on this order.
  await tx.$queryRaw`SELECT id FROM review_case WHERE "submissionId" = ANY(${ids}) ORDER BY id FOR UPDATE`;
  const replaced: string[] = [];
  for (const id of ids) {
    // SUPERSEDED has no legacy status of its own; EXPIRED keeps every status-only reader from treating
    // the replaced copy as waiting, approved or rejected.
    if (await hopDocState(tx, { id, userId }, [...AWAITING_REVIEW_STATES], 'SUPERSEDED', { status: 'EXPIRED', reviewNote: replacedNoteFor(replacementId) })) replaced.push(id);
  }
  if (replaced.length > 0) {
    await tx.reviewCase.updateMany({ where: { submissionId: { in: replaced }, closedAt: null }, data: { closedAt: new Date() } });
  }
  return replaced;
}
