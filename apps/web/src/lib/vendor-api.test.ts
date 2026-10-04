import { describe, expect, it } from 'vitest';
import { money, normalizeVendorOrder, toAmount } from './vendor-api';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';

describe('toAmount — the one coercion seam', () => {
  it('parses the Decimal STRINGS Prisma actually puts on the wire', () => {
    expect(toAmount('4500.00')).toBe(4500);
    expect(toAmount('0.00')).toBe(0);
    expect(toAmount('-125.50')).toBe(-125.5);
    expect(toAmount(' 4500.00 ')).toBe(4500);
  });

  it('accepts numbers from routes that already coerced (analytics, settlements)', () => {
    expect(toAmount(4500)).toBe(4500);
    expect(toAmount(0)).toBe(0);
  });

  it('refuses every value that is not money — no invented zeroes', () => {
    // `Number('')`, `Number(null)` and `Number([])` are all 0. That silent 0 is
    // exactly what this guard exists to stop.
    for (const notMoney of [undefined, null, '', '   ', 'abc', '$4,500', NaN, Infinity, -Infinity, true, false, [], {}, [4500]]) {
      expect(toAmount(notMoney)).toBeNull();
    }
  });
});

describe('money — the honest formatter', () => {
  it('formats a real figure, including a real zero', () => {
    expect(money('4500.00')).toBe(`$${(4500).toLocaleString()}`);
    expect(money(0)).toBe('$0');
  });

  it('renders an em-dash for anything that is not a finite number', () => {
    expect(money(undefined)).toBe('—');
    expect(money(null)).toBe('—');
    expect(money('')).toBe('—');
    expect(money(NaN)).toBe('—');
    // The exact failure this lane exists to kill.
    expect(money(undefined)).not.toContain('NaN');
    expect(money(undefined)).not.toContain('$0');
  });
});

describe('normalizeVendorOrder', () => {
  it('coerces the money columns and leaves every other server field alone', () => {
    const order = normalizeVendorOrder(wireVendorOrder());

    expect(order.totalAmount).toBe(4500);
    expect(order.subtotalCustomer).toBe(4000);
    expect(order.items[0]?.totalCustomer).toBe(3000);
    expect(order.items[1]?.totalCustomer).toBe(1000);

    // Untouched passthrough — nothing the server sent is dropped.
    expect(order.orderNumber).toBe('SW-1001');
    expect(order.deliveryInstructions).toBe('Ring the bell twice');
    expect(order.items[0]?.specialInstructions).toBe('No pepper please');
    expect(order.vendor?.name).toBe('Test Kitchen');
  });

  it('reports a missing total as null rather than 0', () => {
    const raw = wireVendorOrder() as Record<string, unknown>;
    delete raw['totalAmount'];
    const order = normalizeVendorOrder(raw);
    expect(order.totalAmount).toBeNull();
    expect(money(order.totalAmount)).toBe('—');
  });

  it('never resurrects the phantom fields the client used to read', () => {
    const order = normalizeVendorOrder(wireVendorOrder()) as unknown as Record<string, unknown>;
    // `total` / `totalPrice` / `notes` / `pickupCode` are not columns; the API
    // sends none of them, so the normalizer must not manufacture them either.
    expect(order['total']).toBeUndefined();
    expect(order['notes']).toBeUndefined();
    expect(order['pickupCode']).toBeUndefined();
    expect((order['items'] as Array<Record<string, unknown>>)[0]?.['totalPrice']).toBeUndefined();
  });
});
