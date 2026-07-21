import { describe, it, expect } from 'vitest';
import { startOfDayGY, startOfWeekGY, startOfMonthGY } from '../utils/time-gy';

// ---------------------------------------------------------------------------
// DASH-06 — Guyana (UTC-4) day/week/month boundaries. The boundary must be
// Guyana-local midnight, i.e. UTC 04:00, not UTC midnight.
// ---------------------------------------------------------------------------

describe('Guyana-local boundaries [DASH-06]', () => {
  it('start of day is Guyana midnight = 04:00 UTC of that Guyana date', () => {
    // 2026-07-21T02:00Z is still 2026-07-20 22:00 in Guyana → the Guyana day is the 20th.
    const d = startOfDayGY(new Date('2026-07-21T02:00:00Z'));
    expect(d.toISOString()).toBe('2026-07-20T04:00:00.000Z');
  });

  it('an instant well inside a Guyana day maps to that same day 04:00Z', () => {
    // 2026-07-21T12:00Z = 08:00 Guyana on the 21st → start = 21st 04:00Z.
    const d = startOfDayGY(new Date('2026-07-21T12:00:00Z'));
    expect(d.toISOString()).toBe('2026-07-21T04:00:00.000Z');
  });

  it('the UTC-midnight naive cut would be WRONG for the last 4h of a Guyana day', () => {
    // 2026-07-21T01:30Z: naive setUTCHours(0) → 2026-07-21T00:00Z (the 21st),
    // but in Guyana it is still the 20th at 21:30. Ours returns the 20th.
    const gy = startOfDayGY(new Date('2026-07-21T01:30:00Z'));
    expect(gy.getUTCDate()).toBe(20); // correct Guyana day
  });

  it('week starts Monday (Guyana)', () => {
    // 2026-07-22 is a Wednesday; the Guyana week started Mon 2026-07-20 00:00 GY = 04:00Z.
    const d = startOfWeekGY(new Date('2026-07-22T15:00:00Z'));
    expect(d.toISOString()).toBe('2026-07-20T04:00:00.000Z');
  });

  it('month starts on the 1st (Guyana)', () => {
    const d = startOfMonthGY(new Date('2026-07-22T15:00:00Z'));
    expect(d.toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });
});
