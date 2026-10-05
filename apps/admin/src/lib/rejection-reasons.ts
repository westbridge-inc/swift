/**
 * [ADMIN-CONSOLE] Why a document is rejected: exactly the server's
 * REJECTION_REASON_CODES (apps/api verification.service.ts), in its order. The
 * reject route accepts nothing else, the code is what the applicant is told (a
 * category and a consistent opening line, never the reviewer's note), and the
 * decision record keeps it. The verification page's tests read the API source
 * and fail if this list drifts from it.
 *
 * Retired codes are never offered: NOT_YELLOW went with the owner's ruling of
 * 2026-10-01 (a yellow car is not a taxi requirement; the H plate stays, as
 * WRONG_PLATE_CLASS).
 */
export const REJECTION_REASONS = [
  { code: 'EXPIRED', label: 'Expired' },
  { code: 'UNREADABLE', label: 'Too blurry or dark to read' },
  { code: 'WRONG_DOCUMENT', label: 'Not the document asked for' },
  { code: 'FACE_MISMATCH', label: 'The face does not match' },
  { code: 'NAME_MISMATCH', label: 'The name does not match the account' },
  { code: 'INSURANCE_NOT_HIRE', label: 'Insurance does not cover hire (taxi) work' },
  { code: 'SUSPECTED_TAMPERING', label: 'Looks altered' },
  { code: 'DUPLICATE', label: 'Already used on another account' },
  { code: 'INCOMPLETE', label: 'Part of the document is cut off' },
  { code: 'WRONG_PLATE_CLASS', label: 'Not an H (hire) plate, for a taxi' },
] as const;

export type RejectionReasonCode = (typeof REJECTION_REASONS)[number]['code'];

/**
 * [DOC-1 §24.2] The fraud class (the server's FRAUD_CLASS_CODES): suspicion,
 * never an automatic reject. The first reviewer's verdict sends the document
 * to a SECOND reviewer and it stays pending; only a different reviewer
 * confirming it rejects it.
 */
export const SECOND_REVIEW_CODES: ReadonlySet<RejectionReasonCode> = new Set<RejectionReasonCode>([
  'FACE_MISMATCH',
  'SUSPECTED_TAMPERING',
  'DUPLICATE',
]);

export function rejectionLabel(code: RejectionReasonCode): string {
  return REJECTION_REASONS.find((reason) => reason.code === code)?.label ?? code;
}

export function isRejectionReasonCode(value: string): value is RejectionReasonCode {
  return REJECTION_REASONS.some((reason) => reason.code === value);
}
