/**
 * Checklist document types whose identifier is evidence about a PERSON.
 * This leaf module deliberately imports nothing: identity-signal admission
 * must not recreate the doc-registry ↔ verification-service runtime cycle.
 */
export const IDENTITY_DOC_TYPES: readonly string[] = [
  'owner_national_id',
  'national_id',
  'passport',
];
