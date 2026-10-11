export function emptyChecklistCopy(status: { categoryUnavailable?: boolean }): { title: string; body: string } {
  if (status.categoryUnavailable) {
    return {
      title: 'Service checks pending',
      body: 'This service is unavailable while its required checks are prepared. You cannot receive requests yet.',
    };
  }
  return {
    title: 'Verification steps unavailable',
    body: 'We cannot confirm your requirements right now. Try again later.',
  };
}

/**
 * [Owner, 1 Oct · truth] The documents the server compares with the profile
 * selfie right now — GET /verification/status's `faceMatchDocTypes`. Empty
 * while face-matching is off. The card's "Face-matched" line is a claim about
 * what the server does, so only the server's own list can make it: anything
 * that is not a list of document types names none.
 */
export function faceMatchedDocTypes(status: { faceMatchDocTypes?: unknown } | null | undefined): ReadonlySet<string> {
  const named = status?.faceMatchDocTypes;
  if (!Array.isArray(named)) return new Set();
  return new Set(named.filter((docType): docType is string => typeof docType === 'string' && docType.length > 0));
}

/**
 * [REPLACE-PENDING · owner request 8 Oct 2026] What a document waiting for review says: it can be replaced
 * (the person sent the wrong one), and once replaced it says so. The server marks a copy that replaced an
 * earlier waiting one (`replaced` on GET /verification/status documents).
 */
export function pendingDocumentLabel(replaced: boolean, submittedAt?: string | null): string {
  if (replaced) return 'Replaced — waiting for review · tap to replace again';
  const on = submittedAt ? new Date(submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
  return on ? `Submitted ${on} — in review · tap to replace` : 'In review · tap to replace';
}
