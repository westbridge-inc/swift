import { reviewerTypedFields } from '../../modules/verification/identity-signal-policy';

/**
 * [VERIFY-DOCS · owner ruling 6 Oct 2026] What a reviewer types when approving a
 * document of this type in the console: the number printed on an ID or licence,
 * or a police clearance's issue date. Fixtures type a number unique to the
 * DOCUMENT (never shared by accident between two people, so no fixture joins two
 * accounts into one identity) and a clearance issued 60 days ago.
 */
export function reviewerTyped(docType: string, documentId: string): Record<string, string> {
  const typed: Record<string, string> = {};
  for (const field of reviewerTypedFields(docType)) {
    if (field === 'documentNumber') typed['documentNumber'] = `T${documentId.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 40);
    if (field === 'issuedOn') typed['issuedOn'] = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  }
  return typed;
}
