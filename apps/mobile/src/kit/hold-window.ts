/** [REPORT-009 F-01] The hold ring's PURE decision seams — kept free of any
 *  react-native import so the rail-aware cancellation honesty matrix is
 *  regression-testable without a native render harness. */

/** Whether the live countdown ring may render at all. A cancelled order keeps
 *  its `holdExpiresAt` as server history — never a live "you can still
 *  cancel" ring over the cancelled banner. */
export function holdRingActive(holdExpiresAt: string | null | undefined, now: number, hidden: boolean): boolean {
  if (hidden) return false;
  return !!holdExpiresAt && new Date(holdExpiresAt).getTime() - now > 0;
}

export type HoldRingWindow = {
  startsAtMs: number;
  expiresAtMs: number;
  totalMs: number;
  remainingMs: number;
  progress: number;
};

/** A ring exists only when BOTH ends of its duration came from the server.
 *  Never synthesize a five-minute start when the order response is incomplete:
 *  server hold configuration can vary, and a plausible-looking arc would lie. */
export function holdRingWindow(
  holdExpiresAt: string | null | undefined,
  placedAt: string | null | undefined,
  now: number,
  hidden: boolean,
): HoldRingWindow | null {
  if (!holdRingActive(holdExpiresAt, now, hidden) || !placedAt) return null;
  const startsAtMs = new Date(placedAt).getTime();
  const expiresAtMs = new Date(holdExpiresAt!).getTime();
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(expiresAtMs) || startsAtMs >= expiresAtMs) return null;
  const totalMs = expiresAtMs - startsAtMs;
  const remainingMs = Math.max(0, expiresAtMs - now);
  return {
    startsAtMs,
    expiresAtMs,
    totalMs,
    remainingMs,
    progress: Math.max(0, Math.min(1, remainingMs / totalMs)),
  };
}

/** MOBILE_MONEY + PENDING: the pay link opened at checkout, so "cancelling is
 *  free" may be FALSE — the customer might have already sent the money. The
 *  ring copy says the true thing and points at the party holding it. */
export function holdRingCaption(mmgAmbiguous: boolean): string {
  // [REPORT-011 F-02] The CASH copy no longer promises "free" from a client
  // clock (INV-7: the server owns timers — a skewed device can keep a stale
  // ring alive past the server hold). It states what stays true regardless of
  // clock skew and defers the cost to confirmation, which the server computes.
  return mmgAmbiguous
    ? 'Changed your mind? You can still cancel — if you already sent the MMG payment, the store refunds you directly.'
    : 'Changed your mind? Cancel while the store hasn’t started — the app shows any cost before you confirm.';
}
