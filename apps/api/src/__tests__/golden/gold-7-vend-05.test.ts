import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { createGolden } from './gold-7-helpers';

// ---------------------------------------------------------------------------
// GOLD-7 · VEND-05 — create → two customers race the last unit → the losing
// quote identifies its stale cart line → vendor restocks → quote recovers →
// retry buys exactly once. Production inventory routes and checkout, real DB.
// Phone +5920976nnn: audited against source literals and generator ranges.
// ---------------------------------------------------------------------------
const h = createGolden('+5920976', 'gold7-vend05');
beforeAll(() => h.start());
afterAll(() => h.close());

describe('GOLD-7 · VEND-05 — stock collision and quote recovery', () => {
  it('sells the last unit once, preserves the losing cart, then restocks and successfully retries its refreshed quote', async () => {
    const owner = await h.actor(['VENDOR_OWNER']);
    const store = await h.vendor(owner);
    const headers = { 'x-vendor-id': store.vendorId };
    const created = await h.call('POST', '/api/v1/vendor/items', owner.token,
      { categoryId: store.categoryId, name: 'Last golden unit', basePrice: 1200, stockQuantity: 1, isAvailable: true }, headers);
    expect(created.statusCode, created.json().error?.code).toBe(200);
    const itemId = created.json().data.id as string;
    const choices = { [store.vendorId]: 'PICKUP' };
    const quoteUrl = `/api/v1/customer/cart?fulfillmentSelections=${encodeURIComponent(JSON.stringify(choices))}`;
    const customers = [await h.actor(), await h.actor()];
    const cartLineIds: string[] = [];
    for (const customer of customers) {
      await h.fillCart(customer, { vendorId: store.vendorId, itemId });
      const quote = await h.call('GET', quoteUrl, customer.token);
      expect(quote.statusCode).toBe(200);
      expect(quote.json().data).toMatchObject({ totalAmount: 1200, unavailableItemIds: [] });
      cartLineIds.push((await h.sys(() => h.app.prisma.cartItem.findFirstOrThrow({ where: { cart: { customerId: customer.userId } } }))).id);
    }
    const race = await Promise.all(customers.map((customer, index) => h.call('POST', '/api/v1/customer/checkout', customer.token,
      { paymentMethod: 'CASH', fulfillmentSelections: choices }, { 'idempotency-key': `g7-stock-${index}-${nanoid(8)}` })));
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loserIndex = race.findIndex((r) => r.statusCode === 409);
    const winnerIndex = 1 - loserIndex;
    expect(['ITEM_UNAVAILABLE', 'INSUFFICIENT_STOCK']).toContain(race[loserIndex]!.json().error.code);
    const winnerId = race[winnerIndex]!.json().data.order.id as string;
    const allOrders = () => h.sys(() => h.app.prisma.order.findMany({ where: { customerId: { in: customers.map((c) => c.userId) } } }));
    expect((await allOrders()).map((o) => o.id)).toEqual([winnerId]);
    const sold = await h.sys(() => h.app.prisma.item.findUniqueOrThrow({ where: { id: itemId } }));
    expect(sold).toMatchObject({ stockQuantity: 0, isAvailable: false });
    expect(sold.autoHiddenAt).not.toBeNull();
    const sales = await h.sys(() => h.app.prisma.stockMovement.findMany({ where: { itemId, reason: 'SALE' } }));
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ delta: -1, orderId: winnerId });
    expect(await h.sys(() => h.app.prisma.cart.findUnique({ where: { customerId: customers[winnerIndex]!.userId } }))).toBeNull();
    const stale = await h.call('GET', quoteUrl, customers[loserIndex]!.token);
    expect(stale.statusCode).toBe(200);
    expect(stale.json().data.unavailableItemIds).toEqual([cartLineIds[loserIndex]]);

    const restocked = await h.call('POST', `/api/v1/vendor/items/${itemId}/adjust`, owner.token,
      { delta: 2, reason: 'RECEIVED', note: 'Golden restock' }, headers);
    expect(restocked.statusCode, restocked.json().error?.code).toBe(200);
    expect(await h.sys(() => h.app.prisma.item.findUniqueOrThrow({ where: { id: itemId } }))).toMatchObject({ stockQuantity: 2, isAvailable: true, autoHiddenAt: null });
    const fresh = await h.call('GET', quoteUrl, customers[loserIndex]!.token);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().data).toMatchObject({ totalAmount: 1200, unavailableItemIds: [] });
    const retry = await h.call('POST', '/api/v1/customer/checkout', customers[loserIndex]!.token,
      { paymentMethod: 'CASH', fulfillmentSelections: choices }, { 'idempotency-key': `g7-restocked-${nanoid(8)}` });
    expect(retry.statusCode, retry.json().error?.code).toBe(200);
    expect(retry.json().data.order.id).not.toBe(winnerId);
    expect(await allOrders()).toHaveLength(2);
    expect((await h.sys(() => h.app.prisma.item.findUniqueOrThrow({ where: { id: itemId } }))).stockQuantity).toBe(1);
    const ledger = await h.sys(() => h.app.prisma.stockMovement.findMany({ where: { itemId }, orderBy: { occurredAt: 'asc' } }));
    expect(ledger.map((m) => [m.reason, m.delta])).toEqual([['OPENING_BALANCE', 1], ['SALE', -1], ['RECEIVED', 2], ['SALE', -1]]);
    expect(ledger.reduce((sum, m) => sum + m.delta, 0)).toBe(1);
  });
});
