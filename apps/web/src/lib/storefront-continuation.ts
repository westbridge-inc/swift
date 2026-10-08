// A tab-scoped Add intent, never a cart or a source of prices. The live menu
// supplies every name, price and available choice when this is reopened.
const KEY = 'swift_storefront_add';
const INTENT_EPOCH_KEY = 'swift_storefront_add_epoch';
const EPOCH_KEY = 'swift_storefront_epoch';

function currentEpoch(): string {
  return localStorage.getItem(EPOCH_KEY) ?? 'initial';
}

// The shared value contains no identity or selection. Reading it at replay time
// also protects suspended tabs that have not received their storage event yet.
export function invalidateStorefrontContinuations(preserveLocal = false): void {
  const intent = preserveLocal ? readStorefrontContinuation() : null;
  clearStorefrontContinuation();
  try {
    // Queueing the first Add opts this browser into shared invalidation.
    // Ordinary authentication with no Add history writes no browser storage.
    if (localStorage.getItem(EPOCH_KEY) !== null) localStorage.setItem(EPOCH_KEY, crypto.randomUUID());
    if (intent) queueStorefrontContinuation(intent);
  } catch { /* Without a shared epoch, fail closed on continuation. */ }
}

let observing = false;
function observeInvalidation(): void {
  if (observing || typeof window === 'undefined') return;
  observing = true;
  window.addEventListener('storage', event => {
    if (event.key === EPOCH_KEY || event.key === null) readStorefrontContinuation();
  });
}
export type StorefrontContinuation = {
  storeSlug: string;
  itemId: string;
  selectedOptions: Record<string, string[]>;
  returnPath: string;
  quantity?: number;
};

export function clearStorefrontContinuation(): void {
  try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(INTENT_EPOCH_KEY); } catch { /* Storage may be disabled. */ }
}

function validReturn(path: unknown, slug: string): path is string {
  return typeof path === 'string' && typeof slug === 'string'
    && /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)
    && (path === `/store/${slug}` || path.startsWith(`/store/${slug}?`))
    && !/[\\\r\n#]/.test(path);
}

export function readStorefrontContinuation(): StorefrontContinuation | null {
  observeInvalidation();
  try {
    if ((sessionStorage.getItem(INTENT_EPOCH_KEY) ?? 'initial') !== currentEpoch()) {
      clearStorefrontContinuation();
      return null;
    }
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (!value) return null;
    if (!validReturn(value.returnPath, value.storeSlug) || typeof value.itemId !== 'string'
      || (value.quantity !== undefined && (!Number.isInteger(value.quantity) || value.quantity < 1 || value.quantity > 99))
      || !value.itemId || !value.selectedOptions || typeof value.selectedOptions !== 'object'
      || Array.isArray(value.selectedOptions)
      || !Object.values(value.selectedOptions).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) {
      clearStorefrontContinuation();
      return null;
    }
    return {
      storeSlug: value.storeSlug, itemId: value.itemId, returnPath: value.returnPath,
      selectedOptions: value.selectedOptions, quantity: value.quantity ?? 1,
    };
  } catch { clearStorefrontContinuation(); return null; }
}

export function queueStorefrontContinuation(intent: StorefrontContinuation): void {
  clearStorefrontContinuation();
  if (!validReturn(intent.returnPath, intent.storeSlug)) return;
  observeInvalidation();
  try {
    if (localStorage.getItem(EPOCH_KEY) === null) localStorage.setItem(EPOCH_KEY, crypto.randomUUID());
    const epoch = currentEpoch();
    sessionStorage.setItem(INTENT_EPOCH_KEY, epoch);
    sessionStorage.setItem(KEY, JSON.stringify({
      storeSlug: intent.storeSlug, itemId: intent.itemId,
      selectedOptions: intent.selectedOptions, returnPath: intent.returnPath, quantity: intent.quantity ?? 1,
    }));
  } catch { clearStorefrontContinuation(); /* Browsing still works without storage. */ }
}

export function takeStorefrontContinuation(storeSlug: string): StorefrontContinuation | null {
  const intent = readStorefrontContinuation();
  if (!intent || intent.storeSlug !== storeSlug) return null;
  // Remove before delivery. If storage cannot be cleared, do not replay an
  // intent that could otherwise recur on every mount.
  try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(INTENT_EPOCH_KEY); } catch { return null; }
  return intent;
}

/** An explicit unrelated auth destination supersedes the pending menu Add. */
export function storefrontAuthReturn(requested: string | null): string {
  const intent = readStorefrontContinuation();
  if (intent && requested !== null && !validReturn(requested, intent.storeSlug)) {
    clearStorefrontContinuation();
  }
  const path = requested ?? intent?.returnPath ?? '';
  return /^\/(?!\/)/.test(path) && !path.includes('..') && !/[\\\r\n]/.test(path) ? path : '';
}
