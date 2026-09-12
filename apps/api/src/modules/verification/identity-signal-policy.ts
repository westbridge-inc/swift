import { normalizeDocNumber } from '../integrity/normalize';
import { IDENTITY_DOC_TYPES } from './identity-document-types';

/** The synthetic L2 flow always receives a government identity document. */
const L2_IDENTITY_DOC_TYPE = 'identity_l2';
const IDENTITY_NUMBER_DOC_TYPES = new Set<string>([
  ...IDENTITY_DOC_TYPES,
  L2_IDENTITY_DOC_TYPE,
]);

/**
 * Convert only a declared identity-document identifier into a HARD integrity
 * signal. A processor's generic `documentNumber` can also be a policy,
 * licence, permit or vehicle-registration number; those are not evidence that
 * two accounts are one person and must never enter ID_DOC_NUMBER.
 */
export function approvedIdentityDocumentNumber(
  docType: string,
  documentStatus: string,
  raw: unknown,
): string | null {
  // Rejected and pending/manual-review OCR is untrusted input. ID_DOC_NUMBER
  // is HARD and can union accounts plus revoke a later trial, so only the
  // persisted approved verdict may admit it.
  if (
    documentStatus !== 'APPROVED'
    || !IDENTITY_NUMBER_DOC_TYPES.has(docType)
    || typeof raw !== 'string'
  ) {
    return null;
  }
  const normalized = normalizeDocNumber(raw);
  return normalized.length > 0 ? normalized : null;
}
