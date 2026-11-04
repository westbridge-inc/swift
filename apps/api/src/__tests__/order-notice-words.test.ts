import { describe, expect, it } from 'vitest';
import { orderDeliveredWords, orderReadyWords } from '../modules/order/order-notice-words';

// [BUG-HUNT F17] A pickup customer was told "waiting for a rider", and no rider ever comes.
describe('order ready', () => {
  it('pickup: go and collect it, at this store, and no word about a rider', () => {
    const words = orderReadyWords('SW-1', { fulfillment: 'PICKUP', vendor: { name: 'Corner Shop', vendorType: 'STORE' } });
    expect(words).toEqual({ title: 'Ready for pickup', body: 'Your order SW-1 is ready. Go to Corner Shop to collect it.' });
  });

  it('a store that delivers itself is bringing it', () => {
    const words = orderReadyWords('SW-2', { fulfillment: 'DELIVERY', fulfillmentMode: 'VENDOR_DELIVERY', vendor: { name: 'Corner Shop', vendorType: 'STORE' } });
    expect(words.body).toBe('Your order SW-2 is ready. Corner Shop is bringing it to you.');
    expect(words.body).not.toMatch(/rider/);
  });

  it('a Swift rider delivery: food is food, a shop order is an order', () => {
    expect(orderReadyWords('SW-3', { fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', vendor: { vendorType: 'RESTAURANT' } }))
      .toEqual({ title: 'Food Ready!', body: 'Your order SW-3 is ready and waiting for a rider.' });
    expect(orderReadyWords('SW-4', { fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', vendor: { vendorType: 'SUPERMARKET' } }).title).toBe('Order ready');
  });
});

describe('order delivered', () => {
  it('"Enjoy your meal!" belongs to a meal', () => {
    expect(orderDeliveredWords('SW-5', 'RESTAURANT')).toBe('Your order SW-5 has been delivered. Enjoy your meal!');
    for (const other of ['STORE', 'SUPERMARKET', null, undefined]) expect(orderDeliveredWords('SW-6', other)).toBe('Your order SW-6 has been delivered.');
  });
});
