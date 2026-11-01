/**
 * [DOC-1 §3.6 · P3-2] The store's seller status in the owner's words. Pure.
 * [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (a)] The self-declared (unregistered) tier is removed: no store has caps, a
 * nudge or a declaration any more (GET /vendor/tier answers "no limits"), so only the registration line is left.
 */
export type TierView = {
  registration: { onFile: true; recordId: string } | { onFile: false; submission: { status: string; submittedAt: string } | null };
};
export function registrationLine(t: Pick<TierView, 'registration'>): string {
  if (t.registration.onFile) return 'Business registration on file.';
  const sub = t.registration.submission;
  if (!sub) return 'No business registration on file yet.';
  return sub.status === 'PENDING' ? 'Business registration submitted — under review.' : `Business registration ${sub.status.toLowerCase().replace(/_/g, ' ')}.`;
}
/** What every store reads now. */
export const NO_LIMITS_LINE = 'No order or sales limits apply to any store on Swift.';
export const WAYS_IN_LINE = 'A store registers its business name, or trades under its owner’s own name. Your documents say which one yours uses.';
