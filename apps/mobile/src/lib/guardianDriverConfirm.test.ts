import { describe, it, expect } from 'vitest';
import {
  isRetryable, messageFor, outcomeOfError, readConfirmRequest, type ConfirmOutcome,
} from './guardianDriverConfirm';

// ---------------------------------------------------------------------------
// [TST-001] A GREEN TEST APPROVED A DEAD END ON A SAFETY PATH.
//
// `guardian_driver_confirm` is what a driver receives when their passenger did
// not answer a Trip Guardian check-in: the platform is asking the driver to
// confirm the trip's status before it escalates. The router sent it to
// `Delivery` — a screen MoverStack never mounts — and the census test asserted
// that destination AS PASSING, with a comment admitting it:
//
//     why: 'GAP: driver recipient; MoverStack never mounts Delivery — and
//           there is NO driver-side confirm control anywhere in the app …'
//
// `POST /safety/guardian/driver-confirm` existed, complete, with no caller.
// The push arrived, the driver tapped it, and nothing happened.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-03T12:00:00.000Z');
const push = {
  sessionId: 's1',
  cycleId: 'cy1',
  nonce: 'n1',
  respondBy: '2026-09-03T12:10:00.000Z',
  orderId: 'o1',
};

describe('[TST-001] the check the driver is answering is the one they were asked', () => {
  it('the cycle and the nonce come from the push, and both are required', () => {
    expect(readConfirmRequest(push, NOW)).toMatchObject({ state: 'ready', cycleId: 'cy1', nonce: 'n1' });
  });

  it('a push missing either one cannot be answered — never guess the identity of a safety check', () => {
    for (const missing of [{ cycleId: undefined }, { nonce: undefined }, { cycleId: '' }, { nonce: 42 }]) {
      expect(readConfirmRequest({ ...push, ...missing }, NOW))
        .toEqual({ state: 'unanswerable', why: 'missing_identity' });
    }
  });

  it('a check whose window has closed says so instead of sending an answer nobody will use', () => {
    expect(readConfirmRequest(push, new Date('2026-09-03T12:10:00.000Z'))).toEqual({ state: 'expired' });
    expect(readConfirmRequest(push, new Date('2026-09-03T13:00:00.000Z'))).toEqual({ state: 'expired' });
  });

  it('a push with no deadline is still answerable — the server decides, not a missing field', () => {
    expect(readConfirmRequest({ ...push, respondBy: undefined }, NOW)).toMatchObject({ state: 'ready', respondBy: null });
    expect(readConfirmRequest({ ...push, respondBy: 'whenever' }, NOW)).toMatchObject({ state: 'ready', respondBy: null });
  });
});

describe('[TST-001] every server answer means something the driver can act on', () => {
  const cases: Array<[number | undefined, ConfirmOutcome]> = [
    [401, 'signed_out'],
    [403, 'not_yours'],
    [404, 'expired'],
    [409, 'already_answered'],
    [410, 'already_answered'],
    [500, 'unreachable'],
    [undefined, 'unreachable'],
  ];

  it('maps each status to a distinct outcome', () => {
    for (const [status, expected] of cases) {
      const error = status === undefined ? new Error('offline') : { response: { status } };
      expect(outcomeOfError(error), String(status)).toBe(expected);
    }
  });

  it('only an unreachable server is worth retrying — the rest are answers', () => {
    expect(isRetryable('unreachable')).toBe(true);
    for (const outcome of ['confirmed', 'already_answered', 'expired', 'not_yours', 'signed_out'] as const) {
      expect(isRetryable(outcome), outcome).toBe(false);
    }
  });

  it('every outcome says what it means for the person the check is about', () => {
    for (const outcome of ['confirmed', 'already_answered', 'expired', 'not_yours', 'signed_out', 'unreachable'] as const) {
      const message = messageFor(outcome);
      expect(message.length, outcome).toBeGreaterThan(20);
      expect(message, outcome).not.toMatch(/error|failed|invalid/i);
    }
    // and the one that leaves the check open says so, because a driver who
    // walks away from an unanswered safety check should know it is still open
    expect(messageFor('unreachable')).toMatch(/stays open/);
    expect(messageFor('expired')).toMatch(/safety team/);
  });
});
