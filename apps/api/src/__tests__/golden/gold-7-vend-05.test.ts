import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { createGolden, type Actor } from './gold-7-helpers';

// ---------------------------------------------------------------------------
// GOLD-7 · VEND-05 — create → two customers race the last unit → the losing
// quote identifies its stale cart line → vendor restocks → quote recovers →
// retry buys exactly once. Production inventory routes and checkout, real DB.
// Phone +5920976nnn: audited against source literals and generator ranges.
// ---------------------------------------------------------------------------
const h = createGolden('+5920976', 'gold7-vend05');
beforeAll(() => h.start());
afterAll(() => h.close());


async function raceCheckouts(customers: Actor[], choices: Record<string, string>, itemId: string, stock: number) {
  // [G7-02] Hold the real stock snapshots until BOTH requests have read the
  // last unit. No checkout can commit before its competitor has observed 1.
  // Only scheduling is controlled: routes, reads and transactions stay real.
  const snapshots = new Map<string, number | null>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; release(); }, 10_000);
  const readCart = h.app.prisma.cart.findUnique.bind(h.app.prisma.cart);
  const pausedRead = vi.spyOn(h.app.prisma.cart, 'findUnique').mockImplementation(((args: Prisma.CartFindUniqueArgs) => {
    return readCart(args).then(async (row) => {
      const customerId = args.where.customerId;
      if (customerId && customers.some((c) => c.userId === customerId) && args.include?.items) {
        const cart = row as Prisma.CartGetPayload<{ include: { items: { include: { item: true } } } }> | null;
        const item = cart?.items.find((line) => line.itemId === itemId)?.item;
        if (item && !snapshots.has(customerId)) {
          snapshots.set(customerId, item.stockQuantity);
          if (snapshots.size === 2) release();
          await gate;
        }
      }
      return row;
    });
  }) as unknown as typeof readCart);
  const race = await (async () => {
    try {
      return await Promise.all(customers.map((customer, index) => h.call('POST', '/api/v1/customer/checkout', customer.token,
        { paymentMethod: 'CASH', fulfillmentSelections: choices }, { 'idempotency-key': `g7-stock-${index}-${nanoid(8)}` })));
    } finally { release(); clearTimeout(deadline); pausedRead.mockRestore(); }
  })();
  expect(timedOut, 'both checkout stock reads must reach the barrier').toBe(false);
  expect([...snapshots.values()]).toEqual([stock, stock]);
  return race;
}

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
    const race = await raceCheckouts(customers, choices, itemId, 1);
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

  it('rejects a simultaneous two-unit checkout when the competing sale leaves only one unit available', async () => {
    // With one unit left the listing stays visible, so the sold-out visibility
    // guard cannot mask a broken conditional stock decrement [G7-02].
    const owner = await h.actor(['VENDOR_OWNER']);
    const store = await h.vendor(owner);
    const headers = { 'x-vendor-id': store.vendorId };
    const created = await h.call('POST', '/api/v1/vendor/items', owner.token,
      { categoryId: store.categoryId, name: 'Three golden units', basePrice: 1200, stockQuantity: 3, isAvailable: true }, headers);
    expect(created.statusCode).toBe(200);
    const itemId = created.json().data.id as string;
    const choices = { [store.vendorId]: 'PICKUP' };
    const customers = [await h.actor(), await h.actor()];
    for (const customer of customers) await h.fillCart(customer, { vendorId: store.vendorId, itemId }, 2);
    const race = await raceCheckouts(customers, choices, itemId, 3);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = customers[race.findIndex((r) => r.statusCode === 409)]!;
    expect(race.find((r) => r.statusCode === 409)!.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect(await h.sys(() => h.app.prisma.item.findUniqueOrThrow({ where: { id: itemId } }))).toMatchObject({ stockQuantity: 1, isAvailable: true });
    expect(await h.sys(() => h.app.prisma.order.count({ where: { vendorId: store.vendorId } }))).toBe(1);
    expect(await h.sys(() => h.app.prisma.cartItem.findFirstOrThrow({ where: { cart: { customerId: loser.userId } } }))).toMatchObject({ itemId, quantity: 2 });
    const sales = await h.sys(() => h.app.prisma.stockMovement.findMany({ where: { itemId, reason: 'SALE' } }));
    expect(sales.map((row) => row.delta)).toEqual([-2]);
  });

});
