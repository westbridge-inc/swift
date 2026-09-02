import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [TA-S1-001 / MOB-020] The checkout key belongs to the attempt.
//
// lib/checkoutAttempt.test.ts proves the key's lifetime. This pins the three
// seams that give it that lifetime in the app — the only places the attempt
// may begin or end — and that the API client no longer mints its own:
//
//   begin: the checkout mutation, on every tap and retry
//   end:   the order was placed · the cart changed (one seam, invalidateCart)
//   guard: a second tap while the first is in flight is the same attempt
//
// Comments are stripped first so a phrase in a comment can never satisfy an
// assertion about code (the hazard-matching rule).
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOOKS = strip(readFileSync(new URL('./customer.ts', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the stripper', () => {
  it('leaves code behind (a stripper that returned nothing would pass every negative below)', () => {
    expect(HOOKS.length).toBeGreaterThan(5_000);
    expect(API.length).toBeGreaterThan(5_000);
    expect(HOOKS).toContain('export function usePlaceOrder');
  });
});

describe('usePlaceOrder', () => {
  const hook = body(HOOKS, 'export function usePlaceOrder', 'export function useCart');

  it('begins (or reuses) the attempt on every request, and passes its key to the client', () => {
    expect(hook).toContain('customerApi.placeOrder(payload, checkoutAttempt.begin())');
  });

  it('ends the attempt when the order is placed — the next tap is a new order', () => {
    const onSuccess = body(hook, 'onSuccess:', 'track(');
    expect(onSuccess).toContain('checkoutAttempt.end();');
  });

  it('refuses a second mutate while the first is in flight, and releases the guard when it settles', () => {
    expect(hook).toContain('const inFlight = useRef(false);');
    expect(hook).toMatch(/if \(inFlight\.current\) return;\s*inFlight\.current = true;\s*m\.mutate\(variables, options\);/);
    expect(hook).toMatch(/onSettled: \(\) => \{\s*inFlight\.current = false;/);
    expect(hook).toContain('return { ...m, mutate };');
  });
});

describe('the cart seam', () => {
  it('every cart change ends the attempt through the ONE invalidation seam', () => {
    const seam = body(HOOKS, 'function invalidateCart(', 'export function useAddToCart');
    expect(seam).toContain('checkoutAttempt.end();');
    // Every cart mutation hook goes through that seam — none invalidates the
    // cart on its own and forgets the attempt.
    const cartHooks = body(HOOKS, 'export function useAddToCart', 'export function useMySupportTickets');
    const direct = cartHooks.match(/invalidateQueries\(\{ queryKey: \['customer', 'cart'\]/g) ?? [];
    expect(direct).toHaveLength(0);
    expect((cartHooks.match(/invalidateCart\(qc\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe('the API client', () => {
  it('sends the key it is given and mints nothing of its own', () => {
    const place = body(API, 'placeOrder: (', 'getNotifications:');
    expect(place).toContain("headers: { 'Idempotency-Key': idempotencyKey }");
    expect(place).not.toMatch(/Math\.random|Date\.now/);
  });
});
