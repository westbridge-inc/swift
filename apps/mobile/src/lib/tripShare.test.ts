import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  shareMessage, hoursLeft, shareStatusLine, phoneProblem,
  failureOf, linkStillWorks, SHARE_FAILURE_COPY, type MintedShare,
} from './tripShare';

// ---------------------------------------------------------------------------
// [S-16] Sharing a trip — the live link, not a snapshot of one.
//
// The Share button already worked, and that was the problem. It composed text
// — driver, vehicle, plate, and a Google Maps link to the driver's position AT
// THAT INSTANT — and handed it to the OS share sheet. The recipient got a
// photograph of a moving thing: stale on arrival, never updating, impossible
// to revoke, and the plate sitting in someone's chat history forever.
//
// The server has carried the live system the whole time: an expiring 256-bit
// token stored as a digest, a public page that follows the ride, revocation,
// guess-blocking and a kill switch. The button just never called it.
//
// This is the feature someone uses to tell their family to watch them get
// home.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-04T12:00:00.000Z');
const SHARE = (hours = 4): MintedShare => ({
  token: 'x'.repeat(43),
  url: 'https://swift.gy/trip/' + 'x'.repeat(43),
  expiresAt: new Date(NOW.getTime() + hours * 3_600_000).toISOString(),
});

describe('what actually gets shared', () => {
  it('carries the link and says it is LIVE', () => {
    // A recipient who thinks they were sent a screenshot will not open it
    // again — and a live link nobody re-opens is a snapshot.
    const msg = shareMessage(SHARE(), 'Ama');
    expect(msg).toContain(SHARE().url);
    expect(msg).toMatch(/live|updates/i);
  });

  it('carries NO trip detail of its own', () => {
    // Everything is on the revocable page. Anything written into the message
    // is plain text in a chat forever, outliving the trip AND any revocation —
    // which is exactly what the old static share did wrong.
    const msg = shareMessage(SHARE(), 'Ama');
    for (const leak of ['plate', 'Toyota', 'licence', 'license', 'maps.google.com', 'lat', 'lng']) {
      expect(msg.toLowerCase(), `"${leak}" leaked into the share text`).not.toContain(leak.toLowerCase());
    }
  });

  it('works without a name', () => {
    expect(shareMessage(SHARE(), null)).toMatch(/I'm on a Swift taxi/);
    expect(shareMessage(SHARE(), '   ')).toMatch(/I'm on a Swift taxi/);
  });
});

describe('the sharer is told what they have given away', () => {
  it('names the window and the way back', () => {
    // A live location link with no stated end is one a person forgets they
    // created. The revoke path belongs in the same breath — the two facts
    // answer the same worry.
    const line = shareStatusLine(SHARE(4), NOW);
    expect(line).toMatch(/4 hours/);
    expect(line).toMatch(/stop it at any time/i);
  });

  it('reads naturally at one hour, and states an expired link plainly', () => {
    expect(shareStatusLine(SHARE(1), NOW)).toMatch(/about an hour/);
    expect(shareStatusLine(SHARE(-1), NOW)).toMatch(/expired/i);
    expect(hoursLeft(SHARE(-5), NOW)).toBe(0);
  });
});

describe('the number', () => {
  it('accepts E.164 and refuses the rest before the server has to', () => {
    expect(phoneProblem('+5926001234')).toBeNull();
    expect(phoneProblem('')).toBeNull(); // sharing without an SMS is fine
    expect(phoneProblem('6001234')).toMatch(/international/i);
    expect(phoneProblem('592 600 1234')).toMatch(/international/i);
  });
});

describe('an SMS failure is not a share failure', () => {
  it('keeps the link when only the text message failed', () => {
    // The server deliberately does not fail a mint when the SMS fails: the
    // link exists and works either way. Telling someone "sharing failed" while
    // they hold a working link is how a person gives up mid-ride.
    for (const code of ['RATE_LIMITED', 'SMS_BUDGET_EXCEEDED'] as const) {
      expect(linkStillWorks(failureOf(code)), code).toBe(true);
      expect(SHARE_FAILURE_COPY[code]).toMatch(/still works/i);
    }
  });

  it('a real failure does not pretend there is a link', () => {
    for (const code of ['NOT_A_TRIP', 'TRIP_OVER', 'UNKNOWN'] as const) {
      expect(linkStillWorks(failureOf(code)), code).toBe(false);
      expect(SHARE_FAILURE_COPY[code]).not.toMatch(/still works/i);
    }
  });

  it('an unknown failure points at the SOS button', () => {
    // If sharing broke while someone was worried enough to share, the next
    // thing they need is the thing that pages a human.
    expect(SHARE_FAILURE_COPY.UNKNOWN).toMatch(/SOS/);
    expect(failureOf(undefined)).toBe('UNKNOWN');
    expect(failureOf('SOMETHING_NEW')).toBe('UNKNOWN');
  });
});

describe('the screen calls the real thing', () => {
  const TAXI = readFileSync(
    join(process.cwd(), 'src/modules/movement/screens/TaxiScreen.tsx'),
    'utf8',
  );

  it('mints a share instead of composing a text snapshot', () => {
    expect(TAXI).toMatch(/shareTrip\(/);
    expect(TAXI).toMatch(/safetyApi\.shareTrip|shareTripMutation/);
  });

  it('no longer pastes a raw position into the message', () => {
    // The old build sent `https://maps.google.com/?q=<lat>,<lng>` — one frozen
    // position, in plain text, that could never be taken back.
    const shareFn = TAXI.slice(TAXI.indexOf('const shareTrip'), TAXI.indexOf('const shareTrip') + 1400);
    expect(shareFn, 'a frozen map position is still being shared').not.toMatch(/maps\.google\.com/);
    expect(shareFn).not.toMatch(/licensePlate/);
  });
});
