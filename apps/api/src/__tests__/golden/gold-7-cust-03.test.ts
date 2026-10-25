import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { createGolden } from './gold-7-helpers';

// ---------------------------------------------------------------------------
// GOLD-7 · CUST-03 — one customer's cancel → fresh order → pickup conversion
// → reorder → stale-cart refusal → refreshed quote → successful retry.
// The cancel/ready concurrency leg remains mounted in gold-2-e04-stale-ready.
// DISPATCH_EXHAUSTION is explicitly OFF then ON on the same delivery order.
// The stale screen uses a real DB read held before checkout prices that
// snapshot; the other screen changes the cart through the mounted route.
// Phone +5920973nnn: range-audited; real push delivery is device-only.
// ---------------------------------------------------------------------------
const h = createGolden('+5920973', 'gold7-cust03');
beforeAll(() => h.start());
afterAll(async () => { vi.unstubAllEnvs(); await h.close(); });

describe('GOLD-7 · CUST-03 — cancellation, pickup and reorder recovery', () => {
  it('cancels, converts only with the flag on, reorders and retries an honestly refused stale cart', async () => {
    const owner = await h.actor(['VENDOR_OWNER']);
    const store = await h.vendor(owner);
    const customer = await h.actor();
    const checkout = (key: string) => h.call('POST', '/api/v1/customer/checkout', customer.token,
      { paymentMethod: 'CASH' }, { 'idempotency-key': key });
    await h.fillCart(customer, { vendorId: store.vendorId, itemId: store.itemId });
    const first = await checkout(`g7-cancel-${nanoid(8)}`);
    expect(first.statusCode, first.json().error?.code).toBe(200);
    const cancelledId = first.json().data.order.id as string;
    const cancel = await h.call('POST', `/api/v1/customer/orders/${cancelledId}/cancel`, customer.token, { reason: 'Changed pickup plans' });
    expect(cancel.statusCode, cancel.json().error?.code).toBe(200);
    expect((await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id: cancelledId } }))).status).toBe('CANCELLED');

    await h.fillCart(customer, { vendorId: store.vendorId, itemId: store.itemId });
    const second = await checkout(`g7-convert-${nanoid(8)}`);
    expect(second.statusCode, second.json().error?.code).toBe(200);
    const id = second.json().data.order.id as string;
    const before = await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id } }));
    expect(Number(before.deliveryFee)).toBeGreaterThan(0);
    vi.stubEnv('DISPATCH_EXHAUSTION', '');
    const off = await h.call('POST', `/api/v1/customer/orders/${id}/convert-to-pickup`, customer.token, {});
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id } }))) === JSON.stringify(before)).toBe(true);
    vi.stubEnv('DISPATCH_EXHAUSTION', '1');
    const converted = await h.call('POST', `/api/v1/customer/orders/${id}/convert-to-pickup`, customer.token, {});
    expect(converted.statusCode, converted.json().error?.code).toBe(200);
    const pickup = await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id } }));
    expect(pickup.fulfillment).toBe('PICKUP');
    expect(Number(pickup.deliveryFee)).toBe(0);
    expect(Number(pickup.tipAmount)).toBe(0);
    expect(Number(pickup.totalAmount)).toBe(Number(before.totalAmount) - Number(before.deliveryFee) - Number(before.tipAmount));
    expect(typeof pickup.pickupCode === 'string' && /^\d{6}$/.test(pickup.pickupCode)).toBe(true);
    const reordered = await h.call('POST', `/api/v1/customer/orders/${id}/reorder`, customer.token, {});
    expect(reordered.statusCode, reordered.json().error?.code).toBe(200);
    expect(reordered.json().data).toMatchObject({ itemsAdded: 1, unavailableItems: 0 });
    const cart = await h.sys(() => h.app.prisma.cart.findUniqueOrThrow({ where: { customerId: customer.userId }, include: { items: true } }));

    let reached!: () => void;
    let release!: () => void;
    const atRead = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realRead = h.app.prisma.cart.findUnique.bind(h.app.prisma.cart);
    let held = false;
    const spy = vi.spyOn(h.app.prisma.cart, 'findUnique').mockImplementation((async (args: Parameters<typeof realRead>[0]) => {
      const row = await realRead(args);
      if (!held && args.where.customerId === customer.userId && args.include?.items) {
        held = true;
        reached();
        await gate;
      }
      return row;
    }) as never);
    const pending = checkout(`g7-stale-${nanoid(8)}`);
    try {
      await Promise.race([atRead, new Promise((_, reject) => setTimeout(() => reject(new Error('checkout never read its cart')), 10_000))]);
      const edit = await h.call('PUT', `/api/v1/customer/cart/items/${cart.items[0]!.id}`, customer.token, { quantity: 2 });
      expect(edit.statusCode, edit.json().error?.code).toBe(200);
      release();
      const stale = await pending;
      expect(stale.statusCode, stale.json().error?.code).toBe(409);
      expect(stale.json().error.code).toBe('CART_CHANGED');
    } finally { release(); spy.mockRestore(); await pending; }
    expect(await h.sys(() => h.app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(2);
    const fresh = await h.call('GET', '/api/v1/customer/cart', customer.token);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().data.subtotalCustomer).toBe(2400);
    const retry = await checkout(`g7-retry-${nanoid(8)}`);
    expect(retry.statusCode, retry.json().error?.code).toBe(200);
    expect(retry.json().data.order.subtotal).toBe(2400);
    expect(await h.sys(() => h.app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(3);
    expect(await h.sys(() => h.app.prisma.cart.findUnique({ where: { customerId: customer.userId } }))).toBeNull();
  });
});
