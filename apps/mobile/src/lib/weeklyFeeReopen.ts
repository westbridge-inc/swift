// [MMG reopen] The Back card's own rule and words: whether to show "Back to MMG's page", Swift's
// deadline line and the do-not-pay-twice warning. Kept out of the shared fee library so the web
// page's first load does not carry them (the card loads only when the server grants a reopen).
// Kept identical across the two independently built apps (census), so it imports nothing.
interface ReopenCheckout { ref: string; status: string; expiresAt: string }
interface ReopenSubscription { reopenableMmgCheckout?: { ref: string; expiresAt: string } | null; latestMmgCheckout?: ReopenCheckout | null }
/** Only the server grants reopen; OPEN by itself never grants another Pay. */
export function reopenableMmg(sub?: ReopenSubscription | null, current?: ReopenCheckout | null, now = Date.now()) {
  const grant = sub?.reopenableMmgCheckout;
  const latest = sub?.latestMmgCheckout;
  const shown = current ?? latest;
  if (!grant || latest?.ref !== grant.ref || latest.status !== 'OPEN' || shown?.ref !== grant.ref || shown.status !== 'OPEN'
    || !(Date.parse(grant.expiresAt) > now) || !(Date.parse(latest.expiresAt) > now)) return undefined;
  return grant;
}
/** Swift's own time limit for the checkout (not the lifetime of MMG's page, which MMG has not documented). */
export function feeExpiry(value: string): string {
  return `Swift keeps this checkout open until ${new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Guyana' })} (Guyana time).`;
}
/** Shown on the Back card: a reopened page must never invite a second payment. */
export const REOPEN_ALREADY_PAID = "Already paid on MMG's page? Don't pay again — we'll confirm it with MMG.";
