// [BUG-HUNT-2 G11 G12 G15 G16 G18 G19] Words true for the person reading them.
import { describe, expect, it } from 'vitest';
import { renderReceiptHtml } from '../modules/order/receipt';
import { partyCaseView } from '../modules/custody/custody-case';
import { parcelReturnWhy } from '../modules/courier/courier.routes';

const base = {
  id: 'o1', orderNumber: 'SW-1', status: 'DELIVERED', placedAt: new Date('2026-11-04T12:00:00.000Z'), paymentMethod: 'CASH', paymentStatus: 'CAPTURED', fulfillment: 'DELIVERY',
  subtotalCustomer: 800, deliveryFee: 0, totalAmount: 800, currencyCode: 'GYD', vendor: null, customer: { firstName: 'Pat', lastName: null }, items: [],
} as never as Parameters<typeof renderReceiptHtml>[0];

describe('[G16] a receipt uses its own words', () => {
  const ride = renderReceiptHtml({ ...base, orderType: 'TAXI', pickupAddress: 'Stabroek', deliveryAddress: 'Kitty', totalAmount: 1100, driver: { firstName: 'Dan', vehicle: 'White Toyota', licensePlate: 'PAB 1234' }, fareBreakdown: { routeFare: 800, waitingMinutes: 12, waitingCharge: 300, total: 1100 } });
  const parcel = renderReceiptHtml({ ...base, orderType: 'COURIER', subtotalCustomer: 0, deliveryFee: 1188, totalAmount: 1188, pickupAddress: 'Stabroek', deliveryAddress: 'Kitty' });

  it('a ride: who drove, the route, the fare, no store words', () => {
    for (const word of ['Paid in cash to your driver', 'Driver: Dan · White Toyota · PAB 1234', 'From: Stabroek', 'To: Kitty', '<td>Fare</td>', 'You paid your driver directly']) expect(ride).toContain(word);
    for (const word of ['on delivery', '>Items<', 'parties shown above']) expect(ride).not.toContain(word);
  });
  it('a parcel: paid to the rider, a delivery fee, no items', () => {
    for (const word of ['Paid in cash to your rider', '<td>Delivery fee</td>', 'You paid your rider directly']) expect(parcel).toContain(word);
    for (const word of ['on delivery', '>Items<', 'Delivery pay for your rider', 'parties shown above']) expect(parcel).not.toContain(word);
  });
  it('a store order keeps its words', () => {
    const store = renderReceiptHtml({ ...base, subtotalCustomer: 800, deliveryFee: 300, totalAmount: 1100 });
    for (const word of ['Paid in cash on delivery', '>Items<', 'Delivery pay for your rider', 'parties shown above']) expect(store).toContain(word);
  });
});

describe('[G15] why a parcel is coming back', () => {
  it.each([
    ['Recipient unreachable', 'We couldn’t reach the recipient.'],
    ['Recipient refused the parcel', 'The recipient refused the parcel.'],
    ['Wrong or incomplete address', 'The address was wrong or incomplete.'],
    ['something the rider typed', 'The rider could not deliver it.'],
  ])('%s', (reason, words) => expect(parcelReturnWhy(reason)).toBe(words));
});

describe('[G19] a rider whose signal died reported nothing', () => {
  const kase = { id: 'c1', state: 'SUPPORT_HOLD' as const, updatedAt: new Date(), ownerUserId: null };
  const order = { orderType: 'COURIER', paymentMethod: 'CASH', subtotalBase: 0 };
  it('the sender is told what is true', () => {
    expect(partyCaseView({ ...kase, reason: 'MOVER_SIGNAL_LOST' }, 'CUSTOMER', order)).toMatchObject({ headline: 'We lost your rider’s signal' });
    expect(partyCaseView({ ...kase, reason: 'MOVER_SIGNAL_LOST' }, 'CUSTOMER', order)!.body).not.toContain('reported a problem');
  });
  it('a rider who did report one keeps those words', () => {
    expect(partyCaseView({ ...kase, reason: 'CRASH' }, 'CUSTOMER', order)!.body).toContain('reported a problem');
  });
});
