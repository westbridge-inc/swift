import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryStatusNote, kitchenCapacityLine, nextKitchenCapacity, storedKitchenCapacity, KITCHEN_CAPACITY_MAX } from './kitchenCapacity';

// [RIDER-SAFE 4/5] The partner app's "How many orders at once" (maxConcurrentOrders) and the note that
// tells a store why customers cannot order delivery right now.
describe('[RIDER-SAFE 4] How many orders at once', () => {
  it('no limit unless the store set a whole number', () => {
    expect(storedKitchenCapacity({ maxConcurrentOrders: null })).toBeNull();
    expect(storedKitchenCapacity({})).toBeNull();
    expect(storedKitchenCapacity({ maxConcurrentOrders: 0 })).toBeNull();
    expect(storedKitchenCapacity({ maxConcurrentOrders: 2.5 })).toBeNull();
    expect(storedKitchenCapacity({ maxConcurrentOrders: 8 })).toBe(8);
  });
  it('More from no limit starts at 10; Fewer from 1 is no limit; never past the most', () => {
    expect(nextKitchenCapacity(null, 'more')).toBe(10);
    expect(nextKitchenCapacity(10, 'fewer')).toBe(9);
    expect(nextKitchenCapacity(1, 'fewer')).toBeNull();
    expect(nextKitchenCapacity(null, 'fewer')).toBeNull();
    expect(nextKitchenCapacity(KITCHEN_CAPACITY_MAX, 'more')).toBe(KITCHEN_CAPACITY_MAX);
  });
  // [REVIEW-F #2214 S3-1] At the cap the server REFUSES new orders (VENDOR_AT_CAPACITY); nothing queues.
  it('says what happens at the limit, the same words as the website, one order as one', () => {
    expect(kitchenCapacityLine(null)).toBe('No limit. Set one if too many orders at once would make every order late: customers are asked to try again in a few minutes.');
    expect(kitchenCapacityLine(1)).toBe('Up to 1 order at a time (new, cooking or ready). Once you have that many, customers cannot order from you until one is collected or cancelled: they are asked to try again in a few minutes.');
    expect(kitchenCapacityLine(12)).toBe('Up to 12 orders at a time (new, cooking or ready). Once you have that many, customers cannot order from you until one is collected or cancelled: they are asked to try again in a few minutes.');
    for (const n of [null, 1, 12]) expect(kitchenCapacityLine(n)).not.toMatch(/wait|queue/i);
    const card = readFileSync(join(__dirname, '..', 'components', 'KitchenCapacityCard.tsx'), 'utf8');
    expect(card).toMatch(/\{kitchenCapacityLine\(count\)\}/);
    expect(card).not.toMatch(/More wait/);
  });
  it('the store account screen offers it to managers of stores that cook or pack, and saves null for no limit', () => {
    const screen = readFileSync(join(__dirname, '..', 'modules', 'vendor', 'screens', 'VendorAccountScreen.tsx'), 'utf8');
    expect(screen).toMatch(/isManager && store && !samplePreview && store\.vendorType !== 'SERVICE' \? \(\s*<KitchenCapacityCard/);
    expect(screen).toMatch(/vendorApi\.updateProfile\(\{ maxConcurrentOrders \}\)/);
  });
});

describe('[RIDER-SAFE 4/5] why delivery is paused', () => {
  it("the store's own backlog, or Swift's pause, in the server's words; nothing while delivery is open", () => {
    expect(deliveryStatusNote({ deliveryOpen: false, reason: 'STORE_BUSY', message: '3 of your orders are waiting for a rider.' }))
      .toEqual({ title: 'New delivery orders are paused', body: '3 of your orders are waiting for a rider.' });
    expect(deliveryStatusNote({ deliveryOpen: false, reason: 'SWIFT_PAUSED', message: 'Swift has paused delivery in your area for now.' })?.title)
      .toBe('Delivery is paused by Swift');
    expect(deliveryStatusNote({ deliveryOpen: true, reason: null, message: null })).toBeNull();
    expect(deliveryStatusNote(undefined)).toBeNull();
  });
  it('the orders home shows it under the store controls', () => {
    const ops = readFileSync(join(__dirname, '..', 'modules', 'vendor', 'screens', 'VendorOps.tsx'), 'utf8');
    expect(ops).toMatch(/const deliveryStatus = useDeliveryStatus\(true\);/);
    expect(ops).toMatch(/<DeliveryStatusNote status=\{deliveryStatus\.data\} \/>/);
  });
});
