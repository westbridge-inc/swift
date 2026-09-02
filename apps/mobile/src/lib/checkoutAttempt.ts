/**
 * [TA-S1-001 / MOB-020] One checkout = one idempotency key.
 *
 * The server side has been right for a long time: with an `Idempotency-Key`
 * the first `/customer/checkout` claims the key for 24 h, a concurrent twin is
 * refused (409 DUPLICATE_REQUEST) and a later replay gets the STORED order
 * back instead of a second one. The client threw that away by minting a fresh
 * key on every call — so a double tap, a retry after a timed-out response and
 * a reopened app were each a brand-new order in the server's eyes, and the
 * only thing standing between the customer and two orders was the cart-clear
 * racing the second request.
 *
 * The key now belongs to the ATTEMPT, not the call:
 *   begin()  → the in-progress attempt's key, or a new one if none is open
 *   end()    → the attempt concluded (order placed) or the intent changed
 *              (the cart was edited): the next tap is a NEW order
 *
 * It is persisted (see checkoutAttemptStore.ts — the encrypted MMKV behind
 * every persisted store) so an app killed mid-request replays the same
 * attempt when it comes back — the server answers with the order it already
 * placed, or places it once. Persistence is best-effort and fails OPEN to
 * memory: a storage fault must never stop someone ordering dinner, and memory
 * alone still ends the double tap. This module is pure so it can be proved
 * without a native store.
 */

export const CHECKOUT_ATTEMPT_STORAGE_KEY = 'swift.checkout.attemptKey.v1';

export interface CheckoutKeyStore {
  get(): string | null;
  set(key: string): void;
  clear(): void;
}

/** `chk_<base36 ms>_<10 base36 chars>` — inside the server's 8–128 window. */
export function mintCheckoutKey(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = random().toString(36).slice(2, 12).padEnd(10, '0');
  return `chk_${now.toString(36)}_${tail}`;
}

export function createCheckoutAttempt(store: CheckoutKeyStore, mint: () => string = mintCheckoutKey) {
  let memory: string | null = null;

  const read = (): string | null => {
    if (memory) return memory;
    try {
      const stored = store.get();
      memory = typeof stored === 'string' && stored.length >= 8 && stored.length <= 128 ? stored : null;
    } catch {
      memory = null;
    }
    return memory;
  };

  return {
    /** The key of the attempt in progress, or null when none is open. */
    current(): string | null {
      return read();
    },
    /** Reuse the open attempt's key, or open one. Never throws. */
    begin(): string {
      const existing = read();
      if (existing) return existing;
      const key = mint();
      memory = key;
      try {
        store.set(key);
      } catch {
        // Memory holds it; the double tap is still one attempt.
      }
      return key;
    },
    /** The order was placed, or the cart changed: whatever comes next is a new order. */
    end(): void {
      memory = null;
      try {
        store.clear();
      } catch {
        // Nothing durable to clear.
      }
    },
  };
}
