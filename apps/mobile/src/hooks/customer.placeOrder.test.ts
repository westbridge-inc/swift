import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [TA-S1-001 / MOB-020] The checkout key belongs to the INTENT.
//
// lib/checkoutAttempt.test.ts proves the intent's lifetime and shape. This
// pins the seams that give it that shape in the app — the only places the
// intent may begin, be marked sent or open, or end — and how each server
// answer is read:
//
//   begin:    the checkout mutation, bound to the principal and the body hash
//   ambiguous: a sent intent with another body is resolved by the receipt
//             probe BEFORE anything is placed — placed ends it, in flight
//             waits, none supersedes
//   sent:     marked before the request leaves; a definitive failure re-opens
//   422 IDEMPOTENCY_KEY_REUSED → the order already exists (never a retry)
//   409 DUPLICATE_REQUEST      → still being placed (never a second order)
//   replayed: true             → counted as a dedupe replay
//   end:      the order was placed · the cart changed (one seam)
//   restart:  a sent intent is probed on the cart screen before the button lives
//
// Comments are stripped first so a phrase in a comment can never satisfy an
// assertion about code (the hazard-matching rule).
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOOKS = strip(readFileSync(new URL('./customer.ts', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));
const CART = strip(readFileSync(new URL('../modules/cart/screens/CartScreen.tsx', import.meta.url), 'utf8'));

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
    expect(CART.length).toBeGreaterThan(5_000);
    expect(HOOKS).toContain('export function usePlaceOrder');
  });
});

describe('the intent', () => {
  const begin = body(HOOKS, 'async function beginCheckoutIntent(', 'export function usePlaceOrder');
  const hook = body(HOOKS, 'export function usePlaceOrder', 'export function useCheckoutRecovery');

  it('is bound to the signed-in principal and the canonical body', () => {
    expect(begin).toContain('const principal = checkoutPrincipal();');
    expect(begin).toContain('const bodyHash = stableBodyHash(payload);');
    expect(begin).toContain('checkoutAttempt.begin({ principal, bodyHash })');
    const principal = body(HOOKS, 'function checkoutPrincipal(): CheckoutPrincipal {', 'type ReceiptProbe');
    expect(principal).toContain('getAuthSessionSnapshot()');
    expect(principal).toContain('generation: session.generation');
  });

  it('an ambiguous intent is resolved by the receipt probe before anything is placed: placed ends it, in flight waits, none supersedes', () => {
    expect(begin).toContain("if (begun.kind !== 'ambiguous') return begun.key;");
    expect(begin).toContain('const probe = await probeReceipt(begun.pending.key);');
    const placed = body(begin, "if (probe.status === 'placed') {", "if (probe.status === 'in_flight')");
    expect(placed).toContain('checkoutAttempt.end();');
    expect(placed).toContain('throw new CheckoutAlreadyPlacedError(probe.orderIds);');
    expect(begin).toContain("if (probe.status === 'in_flight') throw new CheckoutInFlightError();");
    const none = begin.slice(begin.indexOf("if (probe.status === 'in_flight')"));
    expect(none).toContain('checkoutAttempt.end();');
    expect(none).toContain('checkoutAttempt.begin({ principal, bodyHash })');
    // a probe that cannot be answered is IN FLIGHT, never "nothing"
    const probe = body(HOOKS, 'async function probeReceipt(key: string)', 'async function beginCheckoutIntent(');
    expect(probe).toMatch(/catch \{\s*return \{ status: 'in_flight' \};/);
    expect(probe).toContain("return { status: 'in_flight' };\n  } catch");
  });

  it('is marked SENT before the request leaves, and re-opened only on a definitive answer', () => {
    const fn = body(hook, 'mutationFn: async (payload: any) => {', 'meta: { silent: true }');
    expect(fn.indexOf('checkoutAttempt.markSent(key);')).toBeLessThan(fn.indexOf('customerApi.placeOrder(payload, key)'));
    expect(fn).toContain('if (isAxiosError(err) && err.response) checkoutAttempt.markOpen(key);');
    expect(fn).not.toMatch(/markOpen\(key\);\s*\}\s*catch/);
  });

  it('reads each server answer for what it is: 422 is an existing order, 409 is in flight, replayed is a dedupe', () => {
    const fn = body(hook, 'mutationFn: async (payload: any) => {', 'meta: { silent: true }');
    const conflict = body(fn, "if (status === 422 && code === 'IDEMPOTENCY_KEY_REUSED') {", "if (status === 409 && code === 'DUPLICATE_REQUEST') {");
    expect(conflict).toContain("recordCheckoutOutcome('key_body_conflict')");
    expect(conflict).toContain('checkoutAttempt.end();');
    expect(conflict).toContain('throw new CheckoutAlreadyPlacedError');
    const dup = fn.slice(fn.indexOf("if (status === 409 && code === 'DUPLICATE_REQUEST') {"));
    expect(dup).toContain("recordCheckoutOutcome('in_flight_refused')");
    expect(dup).toContain('throw new CheckoutInFlightError();');
    expect(fn).toContain("recordCheckoutOutcome('checkout_dedupe_replay')");
  });

  it('ends when the order is placed, and the guard refuses a second mutate in flight', () => {
    const onSuccess = body(hook, 'onSuccess:', 'onError:');
    expect(onSuccess).toContain('checkoutAttempt.end();');
    expect(hook).toContain('const inFlight = useRef(false);');
    expect(hook).toMatch(/if \(inFlight\.current\) return;\s*inFlight\.current = true;\s*m\.mutate\(variables, options\);/);
    expect(hook).toMatch(/onSettled: \(\) => \{\s*inFlight\.current = false;/);
    expect(hook).toContain('return { ...m, mutate };');
  });
});

describe('the restart', () => {
  it('a sent intent for THIS principal is probed on mount; placed ends it, none re-opens it, in flight leaves it sent', () => {
    const recovery = body(HOOKS, 'export function useCheckoutRecovery()', 'export function useCart');
    expect(recovery).toContain("checkoutAttempt.currentFor({ userId: session.userId, generation: session.generation })");
    expect(recovery).toContain("if (!pending || pending.state !== 'sent') return;");
    expect(recovery).toContain('probeReceipt(pending.key)');
    const placed = body(recovery, "if (probe.status === 'placed') {", "} else if (probe.status === 'none') {");
    expect(placed).toContain('checkoutAttempt.end();');
    expect(placed).toContain('setPlacedOrderIds(probe.orderIds);');
    const none = recovery.slice(recovery.indexOf("} else if (probe.status === 'none') {"));
    expect(none).toContain('checkoutAttempt.markOpen(pending.key);');
    expect(none).not.toContain('checkoutAttempt.end();');
  });
  it('the cart screen holds the button while an intent is being resolved, and shows the two non-failure answers as facts', () => {
    expect(CART).toContain('const recovery = useCheckoutRecovery();');
    expect(CART).toContain('placeOrder.error instanceof CheckoutAlreadyPlacedError');
    expect(CART).toContain('placeOrder.error instanceof CheckoutInFlightError');
    expect((CART.match(/recovery\.recovering \|\| alreadyPlaced \|\| stillPlacing/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(CART).toContain('This order was already placed');
    expect(CART).toContain('This order is already being placed');
  });
});

describe('the cart seam', () => {
  it('every cart change ends the intent through the ONE invalidation seam', () => {
    const seam = body(HOOKS, 'function invalidateCart(', 'export function useAddToCart');
    expect(seam).toContain('checkoutAttempt.end();');
    const cartHooks = body(HOOKS, 'export function useAddToCart', 'export function useMySupportTickets');
    const direct = cartHooks.match(/invalidateQueries\(\{ queryKey: \['customer', 'cart'\]/g) ?? [];
    expect(direct).toHaveLength(0);
    expect((cartHooks.match(/invalidateCart\(qc\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe('the API client', () => {
  it('sends the key it is given and mints nothing of its own; the receipt probe asks by key', () => {
    const place = body(API, 'placeOrder: (', 'checkoutReceipt:');
    expect(place).toContain("headers: { 'Idempotency-Key': idempotencyKey }");
    expect(place).not.toMatch(/Math\.random|Date\.now/);
    const probe = body(API, 'checkoutReceipt:', 'getNotifications:');
    expect(probe).toContain('/customer/checkout/receipts/${encodeURIComponent(idempotencyKey)}');
  });
});
