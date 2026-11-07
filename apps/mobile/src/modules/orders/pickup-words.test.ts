import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickupShowsCode, pickupWords } from './pickup-words';

// [O-2 · REVIEW-F S3-3 on #2055] The store's takeaway code is off by default: the counter asks for the
// customer's first name and order number. [PICKUP · owner 30 Oct 2026: "the code is still there rather than mark
// as picked up"] With the code off the customer gets NO code — the words and the order number, nothing else.
describe('pickupWords — what the counter asks for', () => {
  it('code off: first name and order number, and no code anywhere in the words', () => {
    const words = pickupWords(false);
    expect(words.timeline).toBe('Give your first name and order number at the counter.');
    expect(words.ready).toBe('Give your first name and order number at the counter.');
    expect(words.waiting).toBe('At the counter: your first name and order number');
    expect(JSON.stringify(words)).not.toMatch(/code/i);
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

  it('the code is shown only when the store asks for it (or an older server does not say) and there is one', () => {
    expect(pickupShowsCode({ pickupCode: '482193', pickupCodeRequired: false })).toBe(false);
    expect(pickupShowsCode({ pickupCode: null, pickupCodeRequired: false })).toBe(false);
    expect(pickupShowsCode({ pickupCode: '482193', pickupCodeRequired: true })).toBe(true);
    expect(pickupShowsCode({ pickupCode: '482193' })).toBe(true);
    expect(pickupShowsCode({ pickupCode: null, pickupCodeRequired: true })).toBe(false);
  });

  it('the order screen reads every counter line from it and shows the order number, never the code, when it is off', () => {
    const SCREEN = readFileSync(new URL('./screens/DeliveryScreen.tsx', import.meta.url), 'utf8');
    expect(SCREEN).toContain('pickupWords(order.pickupCodeRequired).timeline');
    expect(SCREEN).toContain('pickupWords(o.pickupCodeRequired).ready');
    expect(SCREEN).toContain('pickupWords(o.pickupCodeRequired).waiting');
    expect(SCREEN).not.toMatch(/Show the pickup code at the counter|Show this code at the counter|Pickup code — show at the counter/);
    // The card: shown for a code the store asks for, or for the name + number check; the big line is the code
    // only when pickupShowsCode says so, else the order number.
    expect(SCREEN).toContain("o.fulfillment === 'PICKUP' && (pickupShowsCode(o) || o.pickupCodeRequired === false)");
    expect(SCREEN.split('{pickupShowsCode(o) ? o.pickupCode : o.orderNumber}').length - 1).toBe(2);
    expect(SCREEN).not.toMatch(/\{o\.pickupCode\}/);
  });
});
