// ---------------------------------------------------------------------------
// [WEB-TAXI · S-16] Sharing a trip from the website — the phone's live link
// (apps/mobile lib/tripShare.ts), word for word: POST /safety/trips/:id/share
// mints an expiring, revocable link to the public trip page; the message around
// it carries NO trip detail of its own, only that the link is live.
// ---------------------------------------------------------------------------

export interface MintedShare {
  token: string;
  url: string;
  expiresAt: string;
}

export function shareMessage(share: MintedShare, firstName?: string | null): string {
  const who = firstName?.trim() ? `${firstName.trim()} is` : "I'm";
  return `${who} on a Swift taxi. Follow the ride live — the map updates until it ends: ${share.url}`;
}

/** Hours left before the link stops working, floored at zero. */
export function hoursLeft(share: Pick<MintedShare, 'expiresAt'>, now = new Date()): number {
  return Math.max(0, Math.floor((new Date(share.expiresAt).getTime() - now.getTime()) / 3_600_000));
}

/** The window and the way back, said together. */
export function shareStatusLine(share: MintedShare, now = new Date()): string {
  const h = hoursLeft(share, now);
  if (h <= 0) return 'This link has expired and no longer shows anything.';
  const window = h === 1 ? 'about an hour' : `about ${h} hours`;
  return `Anyone with this link can follow the ride for ${window}. You can stop it at any time.`;
}

export type ShareFailure = 'NOT_A_TRIP' | 'TRIP_OVER' | 'RATE_LIMITED' | 'SMS_BUDGET_EXCEEDED' | 'UNKNOWN';

/** What happened to the SHARE (never just the text message). */
export const SHARE_FAILURE_COPY: Record<ShareFailure, string> = {
  NOT_A_TRIP: 'Live sharing is for taxi rides.',
  TRIP_OVER: 'This ride has already ended, so there is nothing live to follow.',
  RATE_LIMITED: 'That number was just sent a link. Your link still works — send it any way you like.',
  SMS_BUDGET_EXCEEDED: 'That number has had too many messages today. Your link still works — send it any way you like.',
  UNKNOWN: "We couldn't create the link. Try again — and use the emergency button if you feel unsafe.",
};

export function failureOf(code: unknown): ShareFailure {
  return (['NOT_A_TRIP', 'TRIP_OVER', 'RATE_LIMITED', 'SMS_BUDGET_EXCEEDED'] as const).includes(code as never)
    ? (code as ShareFailure)
    : 'UNKNOWN';
}
