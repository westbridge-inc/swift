import type { Prisma } from '@prisma/client';
import { maskOwnPhone } from './person-contact';
import type { PreviousDecision } from '../verification/previous-decision';
import { reviewerTypedFields } from '../verification/identity-signal-policy';

// ---------------------------------------------------------------------------
// [DOC-SECURITY G3] WHAT A REVIEW QUEUE ROW SAYS — AND ONLY THAT.
//
// The queue sent each document row whole: the storage key of the file, the
// provider reference, the insurer and policy number a reviewer typed, the
// reviewer's own note, the retention and hold columns, and the applicant's
// full phone number. The Review Center uses none of them. A row is now built
// from this allow-list, so a column added to the table later is not sent
// until someone adds it here on purpose.
//
// The applicant's number is always masked. The console shows its last digits
// only; the full number is the person page's audited reveal, never a list row.
// ---------------------------------------------------------------------------

/** What the queue reads. `subjectId` is read for the earlier-decision lookup and never sent. */
export const REVIEW_QUEUE_SELECT = {
  id: true, userId: true, role: true, docType: true, status: true, subjectId: true,
  createdAt: true, expiresAt: true, consentAt: true, privacyNoticeVersion: true,
  // An automatic marker ('auto:…', 'kyc:…') or a reviewer's id: the console says which, in words.
  reviewedBy: true,
  // [BUG-HUNT F23] A paper a reviewer checked and held for ordering day (verification/approval-brake.ts).
  approvalHeldAt: true,
  approvalHeldBy: true,
  user: {
    select: {
      id: true, firstName: true, lastName: true, phone: true, countryCode: true,
      // [A-19] The reviewer ticks "cross-checked against the H-plate": the plate is on the screen.
      driver: { select: { licensePlate: true, vehicleMake: true, vehicleModel: true, vehicleType: true } },
    },
  },
} satisfies Prisma.VerificationDocumentSelect;

export type ReviewQueueDocument = Prisma.VerificationDocumentGetPayload<{ select: typeof REVIEW_QUEUE_SELECT }>;

/** One queue row: the allow-listed fields, the earlier decision, the fields the reviewer types, the number masked. */
export function reviewQueueRow(doc: ReviewQueueDocument & { previousDecision: PreviousDecision | null }) {
  return {
    id: doc.id,
    userId: doc.userId,
    role: doc.role,
    docType: doc.docType,
    status: doc.status,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    consentAt: doc.consentAt,
    privacyNoticeVersion: doc.privacyNoticeVersion,
    reviewedBy: doc.reviewedBy,
    approvalHeldAt: doc.approvalHeldAt,
    approvalHeldBy: doc.approvalHeldBy,
    previousDecision: doc.previousDecision,
    // [VERIFY-DOCS] What the reviewer must type to approve it.
    reviewerTypes: reviewerTypedFields(doc.docType),
    user: doc.user ? maskOwnPhone(doc.user) : null,
  };
}
