import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderReceiptHtml } from '../modules/order/receipt';

// ---------------------------------------------------------------------------
// [FULL-LAUNCH 5 Nov 2026] A receipt's hour is the customer's, in Guyana time, whatever zone the server runs in.
// Containers run in UTC, so a receipt printed the time 4 hours ahead, and an evening order the next day's date.
// The process zone is forced so a Mac set near Guyana cannot pass this by accident.
// ---------------------------------------------------------------------------

const order = (placedAt: Date) => ({
  orderNumber: 'SW-TEST-1', placedAt, status: 'DELIVERED', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
  paymentMethod: 'CASH', paymentStatus: 'CAPTURED', currency: 'GYD', subtotalCustomer: 1000, deliveryFee: 0, discountAmount: 0,
  riderTip: 0, totalAmount: 1000, items: [],
}) as unknown as Parameters<typeof renderReceiptHtml>[0];

describe('[FULL-LAUNCH] the receipt prints Guyana time', () => {
  const zone = process.env['TZ'];
  beforeAll(() => { process.env['TZ'] = 'UTC'; });
  afterAll(() => { if (zone === undefined) delete process.env['TZ']; else process.env['TZ'] = zone; });

  it('the server is on UTC for this proof', () => {
    expect(new Date('2026-11-05T01:30:00Z').getHours()).toBe(1);
  });

  it('an order at 13:30Z reads 09:30', () => {
    expect(renderReceiptHtml(order(new Date('2026-11-05T13:30:00Z')))).toMatch(/5 November 2026 at 09:30/);
  });

  it('an order at 01:30Z on the 5th was placed at 21:30 on the 4th in Guyana', () => {
    const html = renderReceiptHtml(order(new Date('2026-11-05T01:30:00Z')));
    expect(html).toMatch(/4 November 2026 at 21:30/);
    expect(html).not.toMatch(/5 November 2026/);
  });
});
