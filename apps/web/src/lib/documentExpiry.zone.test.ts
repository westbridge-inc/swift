import { describe, expect, it } from 'vitest';

// [FOLLOWUPS] A moment prints its GUYANA day whatever zone the browser is in: the zone is switched BEFORE the helper
// (and its formatter) is loaded. 02:30Z on 1 Jul is 22:30 on 30 Jun in Guyana and 11:30 on 1 Jul in Tokyo.
process.env['TZ'] = 'Asia/Tokyo';
const { documentExpiryDay } = await import('./documentExpiry');

describe('[FOLLOWUPS] documentExpiryDay in a browser far from Guyana', () => {
  it('a moment is its Guyana day; a keyed day is the stored day', () => {
    expect(new Date('2031-07-01T02:30:00.000Z').getDate()).toBe(1); // the browser zone really is ahead
    expect(documentExpiryDay('2031-07-01T02:30:00.000Z')).toBe('30 Jun 2031');
    expect(documentExpiryDay('2031-10-28T00:00:00.000Z')).toBe('28 Oct 2031');
  });
});
