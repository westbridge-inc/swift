import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryNoticeFor } from './deliveryAvailability';

// [RIDER-SAFE 1] The cart's rider note: the server's words, only when checkout acts on them.
describe('[RIDER-SAFE 1] deliveryNoticeFor', () => {
  const msg = 'Riders are busy — about 25 min extra for delivery.';
  it('busy: the honest extra minutes, delivery still orderable (no pickup push)', () => {
    expect(deliveryNoticeFor({ level: 'BUSY', reason: null, extraMinutes: 25, message: msg, gate: true })).toEqual({ text: msg, offerPickup: false });
  });
  it('no riders near (gate on), Swift paused, or the store busy: the reason, with pickup offered', () => {
    expect(deliveryNoticeFor({ level: 'NONE', reason: 'RIDERS_BUSY', extraMinutes: null, message: 'Riders are very busy right now.', gate: true })).toEqual({ text: 'Riders are very busy right now.', offerPickup: true });
    expect(deliveryNoticeFor({ level: 'PAUSED', reason: 'SWIFT_PAUSED', extraMinutes: null, message: 'Swift has paused delivery here for now.', gate: false })).toEqual({ text: 'Swift has paused delivery here for now.', offerPickup: true });
    expect(deliveryNoticeFor({ level: 'PAUSED', reason: 'STORE_BUSY', extraMinutes: null, message: 'paused for a few minutes', gate: true })?.offerPickup).toBe(true);
  });
  it('says nothing when there is nothing true to act on: GOOD, the gate off for riders, a missing or malformed answer', () => {
    expect(deliveryNoticeFor({ level: 'GOOD', reason: null, extraMinutes: null, message: null, gate: true })).toBeNull();
    expect(deliveryNoticeFor({ level: 'BUSY', reason: null, extraMinutes: 25, message: msg, gate: false })).toBeNull();
    expect(deliveryNoticeFor({ level: 'NONE', reason: 'NO_RIDERS', extraMinutes: null, message: 'x', gate: false })).toBeNull();
    expect(deliveryNoticeFor(undefined)).toBeNull();
    expect(deliveryNoticeFor({ level: 'BUSY', gate: true })).toBeNull();
  });
  it('the cart reads it for the store and address it delivers to, and offers pickup from it', () => {
    const screen = readFileSync(join(__dirname, 'screens', 'CartScreen.tsx'), 'utf8');
    expect(screen).toMatch(/customerApi\.getDeliveryAvailability\(riderStore!, effectivePaySelection\.method === 'MMG' \? 'MOBILE_MONEY' : 'CASH'\)/);
    expect(screen).toMatch(/deliveryNoticeFor\(/);
    expect(screen).toMatch(/\{noRiders \|\| riderNotice\?\.offerPickup \? \(/);
  });
});
