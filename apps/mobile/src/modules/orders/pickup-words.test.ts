import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickupWords } from './pickup-words';

// [O-2 · REVIEW-F S3-3 on #2055] The store's takeaway code is off by default: the counter asks for the
// customer's first name and order number. The code stays on screen in case an older store app asks.
describe('pickupWords — what the counter asks for', () => {
  it('code off: first name and order number (the code only if they ask)', () => {
    const words = pickupWords(false);
    expect(words.timeline).toBe('Give your first name and order number at the counter.');
    expect(words.ready).toBe('Give your first name and order number at the counter. If they ask for a code:');
    expect(words.waiting).toBe('At the counter: your first name and order number (this code, if they ask)');
  });

  it('code on, or an older server that does not say: today\'s words', () => {
    for (const required of [true, undefined, null]) {
      expect(pickupWords(required)).toEqual({
        timeline: 'Show the pickup code at the counter.',
        ready: 'Show this code at the counter',
        waiting: 'Pickup code — show at the counter',
      });
    }
  });

  it('the order screen reads every counter line from it (timeline, ready card, waiting card)', () => {
    const SCREEN = readFileSync(new URL('./screens/DeliveryScreen.tsx', import.meta.url), 'utf8');
    expect(SCREEN).toContain('pickupWords(order.pickupCodeRequired).timeline');
    expect(SCREEN).toContain('pickupWords(o.pickupCodeRequired).ready');
    expect(SCREEN).toContain('pickupWords(o.pickupCodeRequired).waiting');
    expect(SCREEN).not.toMatch(/Show the pickup code at the counter|Show this code at the counter|Pickup code — show at the counter/);
  });
});
