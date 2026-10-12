import { describe, expect, it } from 'vitest';
import {
  GUYANA_MIDNIGHT_AFTER_MS, GUYANA_MIDNIGHT_BEFORE_MS, GUYANA_MIDNIGHT_WAIT_TIMEOUT_MS, msUntilClearOfGuyanaMidnight,
} from './helpers/guyana-day-clock';
import { guyanaWallClockParts } from '../utils/guyana-day';

// The wait the "today"-counting journeys take before they run: a suite that
// starts within three minutes before or seven minutes after Guyana midnight
// (04:00 UTC) waits until 00:07 Guyana time; any other start runs at once.

const wait = (iso: string) => msUntilClearOfGuyanaMidnight(new Date(iso));

describe('a suite that counts "today" waits until it is clear of Guyana midnight', () => {
  it('starting at 00:00:30 Guyana (the time CI hit) waits until 00:07', () => {
    expect(wait('2026-10-07T04:00:30.000Z')).toBe(6.5 * 60_000);
  });

  it('starting at 23:58 Guyana waits through midnight until 00:07', () => {
    expect(wait('2026-10-07T03:58:00.000Z')).toBe(9 * 60_000);
  });

  it('the window is three minutes before to seven minutes after; outside it, no wait', () => {
    expect(wait('2026-10-07T03:56:59.999Z')).toBe(0);
    expect(wait('2026-10-07T03:57:00.000Z')).toBe(10 * 60_000);
    expect(wait('2026-10-07T04:06:59.999Z')).toBe(1);
    expect(wait('2026-10-07T04:07:00.000Z')).toBe(0);
    expect(wait('2026-10-07T16:00:00.000Z')).toBe(0);
    expect(GUYANA_MIDNIGHT_BEFORE_MS).toBe(3 * 60_000);
    expect(GUYANA_MIDNIGHT_AFTER_MS).toBe(7 * 60_000);
  });

  it('every start, once its wait is over, is at least seven minutes after and three minutes before Guyana midnight', () => {
    const start = Date.parse('2026-10-06T00:00:00.000Z');
    for (let t = start; t < start + 2 * 86_400_000; t += 37_000) {
      const ms = msUntilClearOfGuyanaMidnight(new Date(t));
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(GUYANA_MIDNIGHT_WAIT_TIMEOUT_MS);
      const { hour, minute } = guyanaWallClockParts(new Date(t + ms));
      const minutesIntoDay = hour * 60 + minute;
      expect(minutesIntoDay).toBeGreaterThanOrEqual(7);
      expect(minutesIntoDay).toBeLessThan(24 * 60 - 3);
    }
  });
});
