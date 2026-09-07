/** [DOC-1 §3.6 · P3-2] The store's tier in the owner's words. Pure. */
export type TierView = {
  tier: 'UNREGISTERED' | 'REGISTERED'; capped: boolean; nearCap: boolean; promotedPlacement: boolean;
  caps: { ordersPerDay: number; grossPerWeek: number; nudgeAtFraction: number };
  usage: { ordersToday: number; grossThisWeek: number };
  registration: { onFile: true; recordId: string } | { onFile: false; submission: { status: string; submittedAt: string } | null };
  declaration: { status: string; signedAt: string; expiresAt: string | null } | null;
};
export function tierLabel(t: Pick<TierView, 'tier'>): { label: string; tone: 'brand' | 'success' } {
  return t.tier === 'REGISTERED' ? { label: 'Registered seller', tone: 'success' } : { label: 'Unregistered seller — limits apply', tone: 'brand' };
}
export function capLine(used: number, cap: number, what: string): { text: string; fraction: number } {
  const fraction = cap > 0 ? Math.min(1, used / cap) : 0;
  return { text: `${what}: ${used.toLocaleString()} of ${cap.toLocaleString()}`, fraction };
}
export function registrationLine(t: Pick<TierView, 'registration'>): string {
  if (t.registration.onFile) return 'Business registration on file.';
  const sub = t.registration.submission;
  if (!sub) return 'No business registration on file yet.';
  return sub.status === 'PENDING' ? 'Business registration submitted — under review.' : `Business registration ${sub.status.toLowerCase().replace(/_/g, ' ')}.`;
}
