// Inventory roll-up for a grocery/goods catalogue. Mirrors the stock semantics
// the item rows and LowStockCard already use, so the summary can never disagree
// with the alerts below it:
//   - "tracked"  : the item has a stockQuantity (restaurant dishes / services
//                  leave it null and are counted in totalItems only)
//   - out        : stockQuantity <= 0  (hidden from customers)
//   - low        : a lowStockThreshold is set and 0 < stockQuantity <= it
//   - in stock   : everything else that's tracked
// Pure, so it's unit-tested and the (un-renderable) card stays trivial.

export interface InventorySummary {
  /** Every catalogue item, tracked or not. */
  totalItems: number;
  /** Items with a stockQuantity (the ones the buckets partition). */
  tracked: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
}

export function inventorySummary(
  categories: Array<{ items?: any[] } | any> | null | undefined,
): InventorySummary {
  const items = (categories ?? []).flatMap((c: any) => c?.items ?? []);
  let tracked = 0;
  let low = 0;
  let out = 0;
  for (const i of items) {
    if (i?.stockQuantity == null) continue;
    tracked++;
    if (i.stockQuantity <= 0) out++;
    else if (i.lowStockThreshold != null && i.stockQuantity <= i.lowStockThreshold) low++;
  }
  return {
    totalItems: items.length,
    tracked,
    inStock: tracked - low - out,
    lowStock: low,
    outOfStock: out,
  };
}
