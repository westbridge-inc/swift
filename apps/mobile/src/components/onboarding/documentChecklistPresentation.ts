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
 * [Legal research G4, in-app ¶17 · owner 15 Oct 2026] What the documents screen says happens to the documents:
 * a person checks them (identity checks are human-only; face-matching is off), and the daily expiry sweep
 * (jobs/queue.ts 'expiry-sweep', 06:00 daily) re-checks their dates.
 */
export const DOCUMENT_REVIEW_PROMISE = 'A person on our team checks your documents and re-checks expiry dates daily.';

/**
 * [Owner, 1 Oct · truth] The documents the server compares with the profile
 * selfie right now — GET /verification/status's `faceMatchDocTypes`. Empty
 * while face-matching is off. Kept as the reading of the server's contract; since the legal research (G4)
 * no screen claims a face was matched, whatever this returns. Anything that is not a list of document
 * types names none.
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

/**
 * [VERIFY-DOCS · owner rulings 6 Oct 2026] The documents the server says this person MAY add —
 * GET /verification/status's `optional` (a police clearance for a mover; a licence holder's
 * national ID). Never required, never in the progress count. Only the server's own list, only
 * strings, and never a type the required checklist already shows.
 */
export function optionalDocTypes(status: { optional?: unknown; checklist?: unknown } | null | undefined): string[] {
  const named = status?.optional;
  if (!Array.isArray(named)) return [];
  const required = new Set(Array.isArray(status?.checklist) ? status!.checklist as unknown[] : []);
  const seen = new Set<string>();
  return named.filter((docType): docType is string => {
    if (typeof docType !== 'string' || docType.length === 0 || required.has(docType) || seen.has(docType)) return false;
    seen.add(docType);
    return true;
  });
}

/** What an optional document is for, in the person's words. */
export function optionalDocHint(docType: string): string {
  // [VERIFY-DOCS] Say what really happens: no screen shows a Police-cleared badge yet, so promise none.
  if (docType === 'police_clearance') return 'Optional. If Swift approves a current one, your account is recorded as police-cleared.';
  if (docType === 'national_id') return 'Optional. Your driver’s licence already proves who you are.';
  return 'Optional. Not needed to start working.';
}
