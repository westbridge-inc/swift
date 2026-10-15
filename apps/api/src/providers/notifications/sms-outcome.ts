// ---------------------------------------------------------------------------
// [AUD-L8b-008] Did a text actually leave Swift?
//
// An SMS send RESOLVES in three cases where no text went to any provider: the
// non-production allowlist refused the number, the store-review seal
// suppressed the fiction's text, or a delivery handoff ledger held the send.
// Each answers with a fixed reference instead of the provider's own, so a
// caller that counts "the promise resolved" counts a text nobody sent. Only a
// provider's reference is a text the provider accepted. The refs live HERE,
// once, and the wrappers that return them import them from here.
// ---------------------------------------------------------------------------

export const SMS_REF_NOT_ALLOWLISTED = 'not-allowlisted';
export const SMS_REF_REVIEW_SUPPRESSED = 'review-suppressed';
export const SMS_REF_HANDOFF_SUPPRESSED = 'suppressed';

const NOT_SENT: ReadonlySet<string> = new Set([SMS_REF_NOT_ALLOWLISTED, SMS_REF_REVIEW_SUPPRESSED, SMS_REF_HANDOFF_SUPPRESSED]);

/** True only when the send's result carries a provider's own reference. */
export function smsAccepted(result: unknown): boolean {
  const ref = typeof result === 'object' && result !== null ? (result as { ref?: unknown }).ref : undefined;
  return typeof ref === 'string' && ref.length > 0 && !NOT_SENT.has(ref);
}
