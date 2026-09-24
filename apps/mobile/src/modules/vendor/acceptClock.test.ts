import { describe, expect, it } from 'vitest';
import { acceptClockLabel } from './acceptClock';

// [E20 · DS234] A booking's accept clock can run for up to a day; the label
// must stay a time a provider can read ("23h 59m"), never "1440:00".
describe('acceptClockLabel', () => {
  it('reads m:ss under an hour — every food order, unchanged', () => {
    expect(acceptClockLabel(0)).toBe('0:00');
    expect(acceptClockLabel(59)).toBe('0:59');
    expect(acceptClockLabel(600)).toBe('10:00');
    expect(acceptClockLabel(3599)).toBe('59:59');
  });

  it('reads hours and minutes from an hour up — a booking days ahead', () => {
    expect(acceptClockLabel(3600)).toBe('1h 00m');
    expect(acceptClockLabel(5 * 3600 + 7 * 60 + 30)).toBe('5h 07m');
    expect(acceptClockLabel(24 * 3600)).toBe('24h 00m');
  });

  it('never shows a negative or fractional clock', () => {
    expect(acceptClockLabel(-5)).toBe('0:00');
    expect(acceptClockLabel(61.9)).toBe('1:01');
  });
});
