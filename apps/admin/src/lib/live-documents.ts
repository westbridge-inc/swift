/**
 * [Owner report 8 Oct 2026] The Drivers and Riders lists showed the legacy "documents verified" flag, so a driver
 * the live document gate lets online read "Pending". The API now sends `documentsLive` — the verdict GO itself
 * uses — and the lists show that. Older API replies (no field) fall back to the legacy flag.
 */
export interface LiveDocuments { allowed: boolean; reason: 'ok' | 'docs' | 'insurance'; validUntil: string | null }
type Mover = { documentsVerified?: boolean; documentsLive?: LiveDocuments | null };

export function liveDocumentsLabel(mover: Mover): string {
  const live = mover.documentsLive;
  if (!live) return mover.documentsVerified ? 'Verified' : 'Pending';
  if (live.allowed) return 'Documents complete';
  return live.reason === 'insurance' ? 'Needs hire insurance' : 'Documents missing';
}

export function liveDocumentsTone(mover: Mover): string {
  const live = mover.documentsLive;
  const ok = live ? live.allowed : !!mover.documentsVerified;
  return ok ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400';
}
