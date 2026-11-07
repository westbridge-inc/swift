/**
 * [owner 30 Oct 2026 · "do what's best for MMG"] How long a new MMG number or pay link waits before it goes live,
 * in the words the owner reads BEFORE saving. The hours are the server's (`mmgNumberHoldHours` /
 * `mmgPayUrlHoldHours` on the profile): 1 for a store's first-ever number; the cool-off
 * (24 h by default) for any pay link, for a change, or for a number added again after removal. Nothing is computed here; an older server that sends no hours
 * gets the old words, which promise no number of hours.
 */
export type MmgHoldKind = 'number' | 'link';

export function holdHoursText(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function mmgHoldSentence(kind: MmgHoldKind, hours: number | null | undefined, hasLive: boolean): string {
  const noun = kind === 'number' ? 'number' : 'link';
  if (typeof hours === 'number' && Number.isFinite(hours) && hours >= 1) {
    return hasLive
      ? `We’ll text you a code first. The new ${noun} goes live in about ${holdHoursText(hours)} — your current ${noun} keeps working until then.`
      : `We’ll text you a code first. Your ${noun} goes live in about ${holdHoursText(hours)}; ${kind === 'number' ? 'until then customers can’t choose MMG for your store' : 'until then nobody can pay you through it'}.`;
  }
  return hasLive
    ? `We’ll text you a code first. The new ${noun} goes live after a hold — your current ${noun} keeps working until then, and we’ll show you exactly when.`
    : `We’ll text you a code first. Your ${noun} goes live after a hold, and we’ll show you exactly when.`;
}
