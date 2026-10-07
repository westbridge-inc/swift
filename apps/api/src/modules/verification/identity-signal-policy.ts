import { normalizeDocNumber } from '../integrity/normalize';
import { IDENTITY_DOC_TYPES, ISSUE_DATE_DOC_TYPES, LICENCE_NUMBER_DOC_TYPES } from './doc-registry';

// The two type lists live in the registry's own text (DOC-INV-2); re-exported for this module's callers.
export { ISSUE_DATE_DOC_TYPES, LICENCE_NUMBER_DOC_TYPES };

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

/**
 * [VERIFY-DOCS · owner ruling 6 Oct 2026] Numbers a REVIEWER types at approval.
 *
 * With manual review nothing is extracted, so the reviewer reads the number off
 * the document and types it; it is kept only as the HMAC blind index of an
 * identity key (never stored as typed), for the duplicate-account check.
 *
 * The driver's licence joins here and NOT in `approvedIdentityDocumentNumber`
 * above: a processor's generic `documentNumber` on a licence may be any number
 * printed on it, but a reviewer is asked for the licence number itself. A
 * licence is issued to one person, and for a motorised mover it is now the
 * photo ID (owner ruling 4), so the same licence on two accounts is one
 * person. It lives in its own namespace (`DL:`): a licence number never
 * matches an identity-card number made of the same characters.
 */
export const REVIEWER_TYPED_NUMBER_DOC_TYPES: ReadonlySet<string> = new Set([
  ...IDENTITY_NUMBER_DOC_TYPES,
  ...LICENCE_NUMBER_DOC_TYPES,
]);
/** Fewer characters than this identify nobody (and would union strangers). */
export const MIN_TYPED_NUMBER_LENGTH = 4;

/** The identity-key value for a number a reviewer typed, or null if the type takes none or the number is too short. */
export function reviewerTypedDocumentSignal(docType: string, raw: unknown): string | null {
  if (!REVIEWER_TYPED_NUMBER_DOC_TYPES.has(docType) || typeof raw !== 'string') return null;
  const normalized = normalizeDocNumber(raw);
  if (normalized.length < MIN_TYPED_NUMBER_LENGTH) return null;
  return LICENCE_NUMBER_DOC_TYPES.has(docType) ? `DL:${normalized}` : normalized;
}

export type ReviewerTypedField = 'documentNumber' | 'issuedOn';

/** What the console must ask the reviewer for, for this document type. */
export function reviewerTypedFields(docType: string): ReviewerTypedField[] {
  if (REVIEWER_TYPED_NUMBER_DOC_TYPES.has(docType)) return ['documentNumber'];
  if (ISSUE_DATE_DOC_TYPES.has(docType)) return ['issuedOn'];
  return [];
}
