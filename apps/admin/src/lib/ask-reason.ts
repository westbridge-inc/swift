'use client';

/**
 * [ADM-006] THE OPERATOR STATES WHY, IN THEIR OWN WORDS.
 *
 * The server now refuses a consequential, money or platform action without a
 * reason. That alone would not have fixed anything here, because this console
 * did send one — the literal string `'Suspended by admin'`, hard-coded at the
 * call site, on every ban and every suspension. A reason nobody was asked for
 * is a field, not an explanation, and the record it left could not be
 * reviewed, appealed or defended any more than a blank one.
 *
 * So the screen asks. A cancelled prompt cancels the action — it never falls
 * back to a default, which is the shape that produced the canned strings in
 * the first place. The length rule matches the server's, so the operator hears
 * about it here rather than as a rejected request.
 */
export const REASON_MIN = 12;

export interface ReasonPrompt {
  /** What the operator is about to do, in their language: "ban this account". */
  action: string;
  /** Optional: who or what it happens to, to name it back to them. */
  subject?: string;
}

/**
 * Ask for a reason. Returns the trimmed reason, or null if the operator
 * cancelled — in which case the caller must do NOTHING.
 */
export function askReason({ action, subject }: ReasonPrompt): string | null {
  const target = subject ? ` for ${subject}` : '';
  const answer = window.prompt(
    `Why are you about to ${action}${target}?\n\nThis goes on the permanent record and is what an appeal or an audit will be answered with. At least ${REASON_MIN} characters.`,
  );
  if (answer === null) return null; // cancelled: nothing happens
  const reason = answer.trim();
  if (reason.length < REASON_MIN) {
    window.alert(`Say why in at least ${REASON_MIN} characters — a word is not a reason anyone can review. Nothing was changed.`);
    return null;
  }
  return reason;
}
