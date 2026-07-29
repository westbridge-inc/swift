import { describe, it, expect } from 'vitest';
import { inventorySummary } from './vendorInventory';

// Inventory roll-up for the grocery/goods catalogue. It must use the SAME stock
// semantics the item rows and LowStockCard already apply, so the summary can't
// disagree with the alerts below it: tracked = has a stockQuantity; out at <= 0;
// low when a lowStockThreshold is set and stock is at/under it (and > 0).

const cat = (items: any[]) => [{ id: 'c', name: 'C', items }];

describe('inventorySummary', () => {
  it('empty / null / undefined → all zeros', () => {
    const z = { totalItems: 0, tracked: 0, inStock: 0, lowStock: 0, outOfStock: 0 };
    expect(inventorySummary([])).toEqual(z);
    expect(inventorySummary(null)).toEqual(z);
    expect(inventorySummary(undefined)).toEqual(z);
  });

  it('untracked items (no stockQuantity) count toward total but never toward stock buckets', () => {
    const s = inventorySummary(cat([{ id: 1, stockQuantity: null }, { id: 2 }]));
    expect(s.totalItems).toBe(2);
    expect(s.tracked).toBe(0);
    expect(s.inStock + s.lowStock + s.outOfStock).toBe(0);
  });

  it('classifies out (<=0), low (<=threshold, >0), and in-stock', () => {
    const s = inventorySummary(
      cat([
        { id: 1, stockQuantity: 0 }, // out
        { id: 2, stockQuantity: -3 }, // out
        { id: 3, stockQuantity: 2, lowStockThreshold: 5 }, // low
        { id: 4, stockQuantity: 5, lowStockThreshold: 5 }, // low (at the level)
        { id: 5, stockQuantity: 40, lowStockThreshold: 5 }, // in stock
        { id: 6, stockQuantity: 8 }, // in stock (no threshold set)
      ]),
    );
    expect(s.outOfStock).toBe(2);
    expect(s.lowStock).toBe(2);
    expect(s.inStock).toBe(2);
    expect(s.tracked).toBe(6);
    expect(s.totalItems).toBe(6);
  });

  it('the buckets always partition the tracked items (in + low + out === tracked)', () => {
    const s = inventorySummary(
      cat([
        { id: 1, stockQuantity: null }, // untracked
        { id: 2, stockQuantity: 0 },
        { id: 3, stockQuantity: 3, lowStockThreshold: 4 },
        { id: 4, stockQuantity: 90 },
      ]),
    );
    expect(s.inStock + s.lowStock + s.outOfStock).toBe(s.tracked);
    expect(s.tracked).toBe(3);
  });

  it('spans multiple categories', () => {
    const s = inventorySummary([
      { items: [{ id: 1, stockQuantity: 0 }] },
      { items: [{ id: 2, stockQuantity: 50 }] },
    ]);
    expect(s.totalItems).toBe(2);
    expect(s.outOfStock).toBe(1);
    expect(s.inStock).toBe(1);
  });
});
