import { describe, expect, it } from 'vitest';
import { documentExpiryDay } from './documentExpiry';

// [FOLLOWUPS] A keyed expiry (UTC midnight) prints the stored day; a moment prints its Guyana day.
describe('documentExpiryDay', () => {
  it('a keyed calendar day (UTC midnight) is that day', () => {
    expect(documentExpiryDay('2031-10-28T00:00:00.000Z')).toBe('28 Oct 2031');
    expect(documentExpiryDay('2030-09-15T00:00:00Z')).toBe('15 Sep 2030');
  });
  it('a moment is its Guyana day (UTC-4)', () => {
    expect(documentExpiryDay('2031-07-01T02:30:00.000Z')).toBe('30 Jun 2031');
    expect(documentExpiryDay('2031-07-01T04:00:00.000Z')).toBe('1 Jul 2031');
  });
  it('no date, no words', () => {
    expect(documentExpiryDay(null)).toBe('');
    expect(documentExpiryDay('')).toBe('');
    expect(documentExpiryDay('not a date')).toBe('');
  });
});
