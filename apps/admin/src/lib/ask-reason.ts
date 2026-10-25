'use client';

import { REASON_MIN } from './reason-rules';

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
 * So the screen asks. A cancelled ask cancels the action — it never falls
 * back to a default, which is the shape that produced the canned strings in
 * the first place. The length rule matches the server's, so the operator hears
 * about it here rather than as a rejected request.
 *
 * [UI-FIX-ADMIN] The browser-prompt `askReason` that lived here is gone: every
 * page asks in the in-page panel (components/mc/ReasonDialog: useAskReason,
 * useActionDialog, useActionRunner), which keeps a refusal in view with the
 * typed reason. ask-reason.test.ts refuses a browser prompt coming back.
 */
export { REASON_MIN };

/**
 * The server's floor, for screens that collect a reason into an input they
 * already own (the advertiser-facing rejection, the claim rejection, …)
 * instead of the panel. One constant, so the floor can never drift apart from
 * the panel's — a 3–11 character answer passes a screen's check and 400s at
 * the gate, which is the second half of this defect.
 */
export function reasonTooShort(reason: string): boolean {
  return reason.trim().length < REASON_MIN;
}

export interface ReasonPrompt {
  /** What the operator is about to do, in their language: "ban this account". */
  action: string;
  /** Optional: who or what it happens to, to name it back to them. */
  subject?: string;
}
