import { describe, it, expect } from 'vitest';
import { holdRingActive, holdRingCaption } from './hold-window';

// [REPORT-009 F-01] The hold ring's REQUIRED regression matrix — the pure
// seams the component renders from (no native harness exists, so the copy and
// visibility decisions are tested directly):
//   held CASH, active                → ring may say cancellation is free
//   held MOBILE_MONEY + PENDING     → direct-refund guidance; never "free"
//   CANCELLED + future holdExpiresAt → NO ring (timestamp is history only)
describe('hold ring — rail-aware cancellation honesty', () => {
  const future = new Date(Date.now() + 90_000).toISOString();
  const past = new Date(Date.now() - 90_000).toISOString();

  it('a held CASH order shows the cancel affordance and defers cost to confirm (no client-clock price promise) [REPORT-011 F-02]', () => {
    expect(holdRingActive(future, Date.now(), false)).toBe(true);
    const caption = holdRingCaption(false);
    expect(caption.toLowerCase()).toContain('cancel');
    // INV-7: no "free"/"no charge" promise from a device clock — the app shows
    // the real cost at confirmation, which the server computes.
    expect(caption).toContain('shows any cost before you confirm');
    expect(caption.toLowerCase()).not.toContain('free');
  });

  it('a held ambiguous-MMG order gives direct-refund guidance and NEVER says free', () => {
    const caption = holdRingCaption(true);
    expect(caption).toContain('the store refunds you directly');
    expect(caption.toLowerCase()).not.toContain('free');
    expect(caption.toLowerCase()).not.toContain('no charge');
  });

  it('a cancelled order with a still-future hold shows NO ring', () => {
    // Cancellation keeps holdExpiresAt as server history; a live "you can
    // still cancel" ring over the cancelled banner would contradict it.
    expect(holdRingActive(future, Date.now(), true)).toBe(false);
  });

  it('an expired or absent hold shows no ring regardless of rail', () => {
    expect(holdRingActive(past, Date.now(), false)).toBe(false);
    expect(holdRingActive(null, Date.now(), false)).toBe(false);
  });
});
