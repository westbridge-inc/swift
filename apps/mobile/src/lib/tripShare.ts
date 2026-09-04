// ---------------------------------------------------------------------------
// [S-16] Sharing a trip — the live link, not a snapshot of one.
//
// The Share button on the taxi screen already worked, and that was the problem.
// It composed a block of text — driver name, vehicle, plate, and a Google Maps
// link to the driver's position AT THAT INSTANT — and handed it to the OS share
// sheet. What the recipient received was a photograph of a moving thing:
//
//   • the position was already stale by the time they read it, and never
//     updated again;
//   • there was nothing to revoke, so the details outlived the trip;
//   • the plate and driver's name travelled as plain text into whatever
//     conversation it was pasted into, permanently.
//
// Meanwhile the server has carried a complete live-share system the whole time
// — mint, revoke, an expiring 256-bit token stored only as a digest, a public
// page that follows the trip, guess-blocking, read throttling and a kill
// switch. `POST /safety/trips/:id/share` even SMSes the link, which is how you
// share with a relative who does not have the app.
//
// So the feature was not missing. The button just never called it.
//
// This is the most-used safety feature in ride-hailing — the one someone uses
// to tell their family to watch them get home — and the version that shipped
// could not be taken back and stopped being true the moment it was sent.
// ---------------------------------------------------------------------------

export interface MintedShare {
  token: string;
  url: string;
  expiresAt: string;
}

/**
 * What actually gets shared.
 *
 * The link carries everything — the live map, the vehicle, the plate — from a
 * page that is revocable and expires. So the message around it stays short and
 * deliberately carries NO trip detail of its own: anything written here is
 * plain text in someone's chat history forever, outliving both the trip and
 * any revocation.
 *
 * One exception, and it is the point of the feature: the message says the link
 * is LIVE. A recipient who thinks they have been sent a screenshot will not
 * open it again, and a live link nobody re-opens is a snapshot.
 */
export function shareMessage(share: MintedShare, firstName?: string | null): string {
  const who = firstName?.trim() ? `${firstName.trim()} is` : "I'm";
  return `${who} on a Swift taxi. Follow the ride live — the map updates until it ends: ${share.url}`;
}

/** Hours left before the link stops working, floored at zero. */
export function hoursLeft(share: Pick<MintedShare, 'expiresAt'>, now = new Date()): number {
  return Math.max(0, Math.floor((new Date(share.expiresAt).getTime() - now.getTime()) / 3_600_000));
}

/**
 * What the sharer is told about a link that is now out of their hands.
 *
 * Naming the expiry is not decoration: a live location link with no stated end
 * is one a person forgets they created. The revoke path is stated alongside it
 * in the same breath, because the two facts answer the same worry.
 */
export function shareStatusLine(share: MintedShare, now = new Date()): string {
  const h = hoursLeft(share, now);
  if (h <= 0) return 'This link has expired and no longer shows anything.';
  const window = h === 1 ? 'about an hour' : `about ${h} hours`;
  return `Anyone with this link can follow the ride for ${window}. You can stop it at any time.`;
}

/** The server takes E.164 only, and refusing here is kinder than a 400. */
export function phoneProblem(phone: string): string | null {
  const trimmed = phone.trim();
  if (!trimmed) return null; // optional — sharing without an SMS is fine
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
    return 'Use the full international number, starting with + — for Guyana that is +592…';
  }
  return null;
}

export type ShareFailure = 'NOT_A_TRIP' | 'TRIP_OVER' | 'RATE_LIMITED' | 'SMS_BUDGET_EXCEEDED' | 'UNKNOWN';

/**
 * Every failure says what happened to the SHARE, not what happened to the SMS.
 *
 * The distinction matters because the server deliberately does not fail a mint
 * when the text message fails to send: the link exists and works either way.
 * Telling someone "sharing failed" when they in fact hold a working link is
 * how a person gives up on the safety feature mid-ride.
 */
export const SHARE_FAILURE_COPY: Record<ShareFailure, string> = {
  NOT_A_TRIP: 'Live sharing is for taxi rides.',
  TRIP_OVER: 'This ride has already ended, so there is nothing live to follow.',
  RATE_LIMITED: 'That number was just sent a link. Your link still works — send it any way you like.',
  SMS_BUDGET_EXCEEDED: 'That number has had too many messages today. Your link still works — send it any way you like.',
  UNKNOWN: "We couldn't create the link. Try again — and use the SOS button if you feel unsafe.",
};

export function failureOf(code: string | undefined): ShareFailure {
  return (['NOT_A_TRIP', 'TRIP_OVER', 'RATE_LIMITED', 'SMS_BUDGET_EXCEEDED'] as const).includes(code as never)
    ? (code as ShareFailure)
    : 'UNKNOWN';
}

/** True when the link is usable despite the failure — an SMS problem, not a
 *  share problem. The UI must keep showing the link in these cases. */
export const linkStillWorks = (f: ShareFailure): boolean => f === 'RATE_LIMITED' || f === 'SMS_BUDGET_EXCEEDED';
