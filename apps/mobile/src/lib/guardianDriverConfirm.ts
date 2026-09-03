/**
 * [TST-001] THE DRIVER HAD NOWHERE TO ANSWER.
 *
 * `guardian_driver_confirm` is the safety push a driver gets when their
 * passenger did not answer a Trip Guardian check: the platform is asking the
 * driver to confirm the trip's status before it escalates. The router sent it
 * to `Delivery` — a screen MoverStack never mounts — and the census test
 * asserted that destination AS PASSING, with a comment admitting it:
 *
 *     why: 'GAP: driver recipient; MoverStack never mounts Delivery — and
 *           there is NO driver-side confirm control anywhere in the app …'
 *
 * A green test approving a dead end on a safety path is worse than a red one.
 * `POST /safety/guardian/driver-confirm` existed, complete, with no caller.
 *
 * This is the decision the screen makes, kept out of the component so it can
 * be exercised without one: what the driver is being asked, whether it can
 * still be answered, and what each server answer means.
 */

export interface DriverConfirmRequest {
  readonly sessionId?: unknown;
  readonly cycleId?: unknown;
  readonly nonce?: unknown;
  readonly respondBy?: unknown;
  readonly orderId?: unknown;
}

export type ConfirmReadiness =
  /** everything needed to answer is present and the deadline has not passed */
  | { readonly state: 'ready'; readonly cycleId: string; readonly nonce: string; readonly respondBy: Date | null }
  /** the push did not carry what the endpoint needs — never guess it */
  | { readonly state: 'unanswerable'; readonly why: 'missing_identity' }
  /** the window closed; ops already has it */
  | { readonly state: 'expired' };

/**
 * Can this check still be answered, and with what?
 *
 * The cycle and the nonce come from the push. Neither is invented: without
 * them there is no question to answer, and inventing one would let a stale
 * notification resolve a check it does not belong to.
 */
export function readConfirmRequest(params: DriverConfirmRequest, now: Date = new Date()): ConfirmReadiness {
  const cycleId = typeof params.cycleId === 'string' && params.cycleId ? params.cycleId : null;
  const nonce = typeof params.nonce === 'string' && params.nonce ? params.nonce : null;
  if (!cycleId || !nonce) return { state: 'unanswerable', why: 'missing_identity' };
  const respondByRaw = typeof params.respondBy === 'string' ? Date.parse(params.respondBy) : Number.NaN;
  const respondBy = Number.isFinite(respondByRaw) ? new Date(respondByRaw) : null;
  if (respondBy && respondBy.getTime() <= now.getTime()) return { state: 'expired' };
  return { state: 'ready', cycleId, nonce, respondBy };
}

export type ConfirmOutcome =
  | 'confirmed'
  /** the server already has an answer for this cycle — the same answer */
  | 'already_answered'
  /** the window closed while the screen was open */
  | 'expired'
  /** this check does not belong to this driver */
  | 'not_yours'
  /** the session ended */
  | 'signed_out'
  /** could not reach the server */
  | 'unreachable';

/** What the server's reply means, in the driver's terms. */
export function outcomeOfError(error: unknown): ConfirmOutcome {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 401) return 'signed_out';
  if (status === 403) return 'not_yours';
  if (status === 404) return 'expired';
  if (status === 409 || status === 410) return 'already_answered';
  return 'unreachable';
}

/** What the screen says. Every line names the safety consequence, because the
 *  driver is being asked to help decide whether someone is in trouble. */
export function messageFor(outcome: ConfirmOutcome): string {
  switch (outcome) {
    case 'confirmed': return 'Thank you — that is recorded. Nothing further is needed from you.';
    case 'already_answered': return 'This check was already answered. Nothing further is needed.';
    case 'expired': return 'This check has closed. Our safety team has already picked it up.';
    case 'not_yours': return 'This check belongs to a different trip. Nothing was recorded.';
    case 'signed_out': return 'Your session ended. Sign in again to answer this check.';
    case 'unreachable': return "Swift couldn't record your answer. Try again — the check stays open until it is answered or it closes.";
  }
}

/** Is the outcome one where trying again could help? */
export function isRetryable(outcome: ConfirmOutcome): boolean {
  return outcome === 'unreachable';
}
