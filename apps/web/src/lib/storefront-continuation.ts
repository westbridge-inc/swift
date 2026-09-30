// A tab-scoped Add intent, never a cart or a source of prices. The live menu
// supplies every name, price and available choice when this is reopened.
const KEY = 'swift_storefront_add';
export type StorefrontContinuation = {
  storeSlug: string;
  itemId: string;
  selectedOptions: Record<string, string[]>;
  returnPath: string;
};

export function clearStorefrontContinuation(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* Storage may be disabled. */ }
}

function validReturn(path: unknown, slug: string): path is string {
  return typeof path === 'string' && typeof slug === 'string'
    && /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)
    && (path === `/store/${slug}` || path.startsWith(`/store/${slug}?`))
    && !/[\\\r\n#]/.test(path);
}

export function readStorefrontContinuation(): StorefrontContinuation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (!value) return null;
    if (!validReturn(value.returnPath, value.storeSlug) || typeof value.itemId !== 'string'
      || !value.itemId || !value.selectedOptions || typeof value.selectedOptions !== 'object'
      || Array.isArray(value.selectedOptions)
      || !Object.values(value.selectedOptions).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) {
      clearStorefrontContinuation();
      return null;
    }
    return {
      storeSlug: value.storeSlug, itemId: value.itemId, returnPath: value.returnPath,
      selectedOptions: value.selectedOptions,
    };
  } catch { return null; }
}

export function queueStorefrontContinuation(intent: StorefrontContinuation): void {
  clearStorefrontContinuation();
  if (!validReturn(intent.returnPath, intent.storeSlug)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({
      storeSlug: intent.storeSlug, itemId: intent.itemId,
      selectedOptions: intent.selectedOptions, returnPath: intent.returnPath,
    }));
  } catch { /* Sign-in and browsing still work when storage is blocked. */ }
}

export function takeStorefrontContinuation(storeSlug: string): StorefrontContinuation | null {
  const intent = readStorefrontContinuation();
  if (!intent || intent.storeSlug !== storeSlug) return null;
  // Remove before delivery. If storage cannot be cleared, do not replay an
  // intent that could otherwise recur on every mount.
  try { sessionStorage.removeItem(KEY); } catch { return null; }
  return intent;
}
