import { describe, expect, it, vi } from 'vitest';
import { createCheckoutAttempt, mintCheckoutKey, type CheckoutKeyStore } from './checkoutAttempt';

// ---------------------------------------------------------------------------
// [TA-S1-001 / MOB-020] One checkout attempt = one idempotency key.
//
// The server refuses a concurrent twin and replays a finished order for the
// SAME key; the client used to mint a new key per call, so every double tap
// and every retry was a new order. These pin the attempt's lifetime: the key
// survives taps and retries, is durable across a restart, and ends only when
// the order is placed or the cart changes.
// ---------------------------------------------------------------------------

function memoryStore(seed: string | null = null): CheckoutKeyStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (seed) values.set('k', seed);
  return {
    values,
    get: () => values.get('k') ?? null,
    set: (key) => { values.set('k', key); },
    clear: () => { values.delete('k'); },
  };
}

describe('the key', () => {
  it('fits the server window (8–128 chars) and is unique per mint', () => {
    const a = mintCheckoutKey();
    const b = mintCheckoutKey();
    for (const k of [a, b]) {
      expect(k).toMatch(/^chk_[0-9a-z]+_[0-9a-z]{10}$/);
      expect(k.length).toBeGreaterThanOrEqual(8);
      expect(k.length).toBeLessThanOrEqual(128);
    }
    expect(a).not.toBe(b);
  });

  it('pads a short random tail instead of shrinking below the window', () => {
    // Math.random() can return 0.5 → "0.i" → a one-character tail.
    expect(mintCheckoutKey(1_000, () => 0.5)).toBe('chk_rs_i000000000');
  });
});

describe('the attempt', () => {
  it('is ONE key across every tap and retry until it ends', () => {
    const store = memoryStore();
    const attempt = createCheckoutAttempt(store);
    const first = attempt.begin();
    expect(attempt.begin()).toBe(first);
    expect(attempt.begin()).toBe(first);
    expect(attempt.current()).toBe(first);
    expect(store.values.get('k')).toBe(first);
  });

  it('ends when the order is placed or the cart changes — the next tap is a NEW order', () => {
    const store = memoryStore();
    const attempt = createCheckoutAttempt(store);
    const first = attempt.begin();
    attempt.end();
    expect(attempt.current()).toBeNull();
    expect(store.values.has('k')).toBe(false);
    const second = attempt.begin();
    expect(second).not.toBe(first);
  });

  it('is durable: an app that comes back after dying mid-request reuses the persisted key', () => {
    const store = memoryStore();
    const before = createCheckoutAttempt(store).begin();
    // A fresh module instance over the same store = the process restarted.
    const after = createCheckoutAttempt(store);
    expect(after.current()).toBe(before);
    expect(after.begin()).toBe(before);
  });

  it('ignores a persisted value outside the server window rather than sending it', () => {
    const attempt = createCheckoutAttempt(memoryStore('short'));
    const key = attempt.begin();
    expect(key).not.toBe('short');
    expect(key.length).toBeGreaterThanOrEqual(8);
  });

  it('fails OPEN: a broken store never blocks an order, and memory alone still ends the double tap', () => {
    const broken: CheckoutKeyStore = {
      get: () => { throw new Error('storage not initialised'); },
      set: () => { throw new Error('storage not initialised'); },
      clear: () => { throw new Error('storage not initialised'); },
    };
    const mint = vi.fn(() => 'chk_memory_only0');
    const attempt = createCheckoutAttempt(broken, mint);
    expect(attempt.begin()).toBe('chk_memory_only0');
    expect(attempt.begin()).toBe('chk_memory_only0');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(() => attempt.end()).not.toThrow();
    expect(attempt.current()).toBeNull();
  });
});
