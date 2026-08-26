/**
 * [F-027-06] How long a toast stays, and why a screen reader needs longer.
 *
 * Every toast was removed after a flat 2.6 seconds. That is fine for a glance,
 * and wrong for assistive technology: a `polite` announcement queues behind
 * whatever is currently speaking, and a long reason takes longer to speak than
 * to read — so the message could be gone before it was ever reached. Manual
 * dismissal can only make the window shorter, never longer.
 *
 * F-243 added the alert role and the live region, which is what made the toast
 * announceable at all. This is the other half: making it still be there.
 *
 * Pure module (no React Native import) so it stays testable in isolation —
 * the same split as kit/text-scale.ts. [DRIFT-09] Kit port, verbatim, of
 * components/ui/toast-duration.
 */

export type ToastTone = 'success' | 'error' | 'info';

/** The window a sighted user gets. Unchanged. */
export const TOAST_MS = 2600;

/** Rough speech rate used to size the window. Deliberately conservative. */
const CHARS_PER_SECOND = 12;

/** [F-028-18] What one queued-ahead announcement costs before ours starts.
 *  A polite announcement waits for everything ahead of it; sizing our window
 *  by our own speech length alone let a short "Saved" vanish while still
 *  waiting its turn. Conservative: a queued item ≈ its own short sentence. */
export const QUEUE_ALLOWANCE_MS = 2_000;

/**
 * @returns milliseconds to display, or `null` to persist until dismissed.
 */
export function toastDurationMs(
  tone: ToastTone,
  title: string,
  description?: string,
  srEnabled = false,
  queuedAhead = 0,
): number | null {
  // Nothing changes for sighted users — this fix ships no visible difference.
  if (!srEnabled) return TOAST_MS;
  // An error nobody heard is the one that matters most.
  if (tone === 'error') return null;
  const chars = title.length + (description?.length ?? 0);
  const own = Math.ceil((chars / CHARS_PER_SECOND) * 1000) + 1500;
  // [F-028-18] ...plus the wait for whatever is queued AHEAD in the polite
  // queue — our window starts at removal-eligibility, the speech starts when
  // the queue reaches us.
  return Math.max(TOAST_MS, own + Math.max(0, queuedAhead) * QUEUE_ALLOWANCE_MS);
}
