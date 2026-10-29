import { reviewerTypedFields } from '../../modules/verification/identity-signal-policy';
import { guyanaWallClockParts } from '../../utils/guyana-day';

/**
 * [VERIFY-DOCS · owner ruling 6 Oct 2026] What a reviewer types when approving a
 * document of this type in the console: the number printed on an ID or licence,
 * or a police clearance's issue date (and, R15/R16, a certificate's year and a business registration's
 * kind). Fixtures type a number unique to the
 * DOCUMENT (never shared by accident between two people, so no fixture joins two
 * accounts into one identity) and a clearance issued 60 days ago.
 */
export function reviewerTyped(docType: string, documentId: string): Record<string, string> {
  const typed: Record<string, string> = {};
  for (const field of reviewerTypedFields(docType)) {
    if (field === 'documentNumber') typed['documentNumber'] = `T${documentId.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 40);
    if (field === 'issuedOn') typed['issuedOn'] = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    // [R15] a certificate checked every January: this year's (Guyana time)
    if (field === 'certificateYear') typed['certificateYear'] = String(guyanaWallClockParts(new Date()).year);
    // [R16] a business registration: a company's incorporation (never expires) unless a test says otherwise
    if (field === 'registrationKind') typed['registrationKind'] = 'COMPANY';
  }
  return typed;
}
