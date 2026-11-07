import { describe, expect, it } from 'vitest';
import { documentExpiryDay } from './documentExpiry';

// [FOLLOWUPS · admin #2155 gyDate rule] A keyed expiry (UTC midnight) prints the stored day; a moment prints its
// Guyana day. The phone zone never moves either (the card test pins three zones on the rendered card).
describe('documentExpiryDay', () => {
  it('a keyed calendar day (UTC midnight) is that day', () => {
    expect(documentExpiryDay('2031-06-30T00:00:00.000Z')).toBe('30 Jun 2031');
    expect(documentExpiryDay(new Date('2028-01-01').toISOString())).toBe('1 Jan 2028');
    expect(documentExpiryDay('2030-09-15T00:00:00Z')).toBe('15 Sep 2030');
  });
  it('a moment is its Guyana day (UTC-4): 02:30 UTC on 1 Jul is 30 Jun in Guyana; 04:00 UTC is 1 Jul', () => {
    expect(documentExpiryDay('2031-07-01T02:30:00.000Z')).toBe('30 Jun 2031');
    expect(documentExpiryDay('2031-07-01T04:00:00.000Z')).toBe('1 Jul 2031');
    expect(documentExpiryDay('2031-06-30T00:00:00.001Z')).toBe('29 Jun 2031');
  });
  it('no date, no words', () => {
    expect(documentExpiryDay(null)).toBe('');
    expect(documentExpiryDay(undefined)).toBe('');
    expect(documentExpiryDay('')).toBe('');
    expect(documentExpiryDay('not a date')).toBe('');
  });
});
