export type BrowseCartSummary = {
  itemCount: number;
  subtotalCustomer: number;
};

/**
 * Market is a product-first lens over the canonical cart. Its pinned action
 * may only repeat totals the API has already calculated; it must not rebuild
 * money from item cards or cached quantities.
 */
export function browseCartSummary(cart: unknown): BrowseCartSummary | null {
  if (!cart || typeof cart !== 'object') return null;

  const row = cart as Record<string, unknown>;
  const itemCount = Number(row['itemCount']);
  const subtotalCustomer = Number(row['subtotalCustomer']);

  if (!Number.isSafeInteger(itemCount) || itemCount <= 0) return null;
  if (!Number.isFinite(subtotalCustomer) || subtotalCustomer < 0) return null;

  return { itemCount, subtotalCustomer };
}
