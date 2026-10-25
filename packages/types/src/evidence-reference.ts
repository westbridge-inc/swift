// [Owner, admin-staging 25 Oct] The evidence reference a finance admin types when resolving a payment
// confirmation: what they checked (a bank or MMG reference, a statement line). A reference, not an essay:
// trimmed, 8-200 characters of letters, digits, spaces and common punctuation. Never a control character
// (no line breaks, no tabs) and nothing a reference never needs (< > { } | \ ` $ and the like).
// The ONE rule: the admin console checks it before asking for approval, the API enforces it.

export const EVIDENCE_REFERENCE_MIN = 8;
export const EVIDENCE_REFERENCE_MAX = 200;
/** Letters and digits of any script, the space, and . , : ; / _ # ( ) [ ] ' " & + @ - */
export const EVIDENCE_REFERENCE_SHAPE = /^[\p{L}\p{N} .,:;/_#()[\]'"&+@-]+$/u;

/** Why a typed evidence reference is refused (checked after trimming), or null when it is fine. */
export function evidenceReferenceProblem(raw: string): string | null {
  const value = raw.trim();
  if (value.length < EVIDENCE_REFERENCE_MIN || value.length > EVIDENCE_REFERENCE_MAX) {
    return `Evidence reference must be ${EVIDENCE_REFERENCE_MIN}–${EVIDENCE_REFERENCE_MAX} characters.`;
  }
  if (!EVIDENCE_REFERENCE_SHAPE.test(value)) {
    return 'Evidence reference can use letters, numbers, spaces and . , : ; / _ # ( ) [ ] \' " & + @ - only (one line).';
  }
  return null;
}
