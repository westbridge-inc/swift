/**
 * [SIGNUP-PHONE · REVIEW-G S3] Whether this browser has signed in with Swift before: a plain "1", never a credential
 * (the session lives only in HttpOnly cookies). Sign-in and sign-up spend the refresh cookie on a page load only when
 * it is set, so a guest's visit never costs a refresh (the refresh limit is shared by everyone behind one address).
 * Storage may be unavailable (private mode): then it reads as "not before", and the person simply signs in.
 */
const KEY = 'swift_signed_in_before';

export function markSignedIn(): void {
  try { localStorage.setItem(KEY, '1'); } catch { /* storage unavailable */ }
}
export function forgetSignedIn(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
export function signedInBefore(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
