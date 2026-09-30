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
//             keeps asking with backoff [AX372 R1], none supersedes
//   sent:     marked before the request leaves; every transport failure is
//             asked about and re-opens only on authoritative "none"
//   422 IDEMPOTENCY_KEY_REUSED → the order already exists (never a retry)
//   409 DUPLICATE_REQUEST      → still being placed (never a second order)
//   replayed: true             → counted as a dedupe replay
//   end:      the matching order was placed · an unsent cart intent changed
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
    expect(begin).toContain('const { principal, payload } = operation;');
    expect(begin).toContain('requireAuthSessionForPrincipal(principal);');
    expect(hook).toContain('const principal = checkoutPrincipal();');
    expect(begin).toContain('const bodyHash = stableBodyHash(payload);');
    expect(begin).toContain('checkoutAttempt.begin({ principal, bodyHash })');
    const principal = body(HOOKS, 'function checkoutPrincipal(): CheckoutPrincipal {', 'async function probeReceipt(');
    expect(principal).toContain('getAuthSessionSnapshot()');
    expect(principal).toContain('generation: session.generation');
  });

  it('an ambiguous intent is resolved by the receipt probe before anything is placed: placed ends it, in flight keeps asking with backoff, none supersedes', () => {
    expect(begin).toContain("if (begun.kind !== 'ambiguous') return begun.key;");
    expect(begin).toContain('probe = await settleSentIntent(begun.pending.key, principal);');
    const settle = body(HOOKS, 'async function settleSentIntent(', 'async function beginCheckoutIntent(');
    expect(settle).toContain('settleUnresolvedIntent(() => probeReceipt(key, principal)');
    const placed = body(begin, "if (probe.status === 'placed') {", "if (probe.status === 'in_flight')");
    expect(placed).toContain('checkoutAttempt.end(begun.pending.key, principal);');
    expect(placed).toContain('throw new CheckoutAlreadyPlacedError(probe.orderIds);');
    expect(begin).toContain("if (probe.status === 'in_flight') throw new CheckoutOutcomeUnknownError();");
    expect(begin.indexOf('settleSentIntent(begun.pending.key, principal)')).toBeLessThan(begin.indexOf('checkoutAttempt.begin({ principal, bodyHash })', begin.indexOf('settleSentIntent(')));
    const none = begin.slice(begin.indexOf("if (probe.status === 'in_flight')"));
    expect(none).toContain('checkoutAttempt.end(begun.pending.key, principal);');
    expect(none).toContain('checkoutAttempt.begin({ principal, bodyHash })');
    // a probe that cannot be answered is IN FLIGHT, never "nothing"
    const probe = body(HOOKS, 'async function probeReceipt(key: string, principal: CheckoutPrincipal)', 'async function beginCheckoutIntent(');
    expect(probe).toMatch(/catch \{\s*requireCheckoutIntent\(key, principal\);\s*return \{ status: 'in_flight' \};/);
    expect(probe).toContain('customerApi.checkoutReceipt(key, session)');
    expect(probe).toContain("return { status: 'in_flight' };\n  } catch");
  });

  it('is marked SENT before the request leaves, and re-opened only on a definitive answer', () => {
    const fn = body(hook, 'mutationFn: async (operation) => {', 'meta: { silent: true }');
    expect(fn.indexOf('checkoutAttempt.markSent(key, principal);')).toBeLessThan(fn.indexOf('customerApi.placeOrder(payload, key, session)'));
    // Exactly one reopening branch, after receipt authority is consulted.
    expect(fn.match(/checkoutAttempt\.markOpen\(key, principal\)/g) ?? []).toHaveLength(1);
    const refusal = "if (checkoutFailureOutcome({ status, code, receipt: settled }) === 'refused') {";
    const none = body(fn, refusal, 'throw err;');
    expect(none).toContain('checkoutAttempt.markOpen(key, principal);');
    expect(fn.indexOf('settled = await settleSentIntent(key, principal);')).toBeLessThan(fn.indexOf(refusal));
    expect(fn).toContain('throw new CheckoutOutcomeUnknownError();');
    expect(fn).not.toMatch(/markOpen\(key, principal\);\s*\}\s*catch/);
  });

  it('reads each server answer for what it is: 422 is an existing order, 409 is in flight, replayed is a dedupe', () => {
    const fn = body(hook, 'mutationFn: async (operation) => {', 'meta: { silent: true }');
    const conflict = body(fn, "if (status === 422 && code === 'IDEMPOTENCY_KEY_REUSED') {", "if (status === 409 && code === 'DUPLICATE_REQUEST') {");
    expect(conflict).toContain("recordCheckoutOutcome('key_body_conflict')");
    expect(conflict).toContain('checkoutAttempt.end(key, principal);');
    expect(conflict).toContain('throw new CheckoutAlreadyPlacedError');
    const dup = fn.slice(fn.indexOf("if (status === 409 && code === 'DUPLICATE_REQUEST') {"));
    expect(dup).toContain("recordCheckoutOutcome('in_flight_refused')");
    expect(dup).toContain('throw new CheckoutInFlightError();');
    expect(fn).toContain("recordCheckoutOutcome('checkout_dedupe_replay')");
  });

  it('ends when the order is placed, and the guard refuses a second mutate in flight', () => {
    const onSuccess = body(hook, 'onSuccess:', 'onError:');
    expect(onSuccess).toContain('!current(operation)');
    expect(onSuccess).toContain('checkoutAttempt.end(operation.key, operation.principal)');
    expect(hook).toContain('const inFlight = useRef<CheckoutOperation | null>(null);');
    expect(hook).toContain('samePrincipalBoundary(inFlight.current.principal, principal)');
    expect(hook).toContain('if (operation) m.mutate(operation, callbacks(operation, options));');
    expect(hook).toContain('if (inFlight.current === operation) inFlight.current = null;');
    expect(hook).toContain('return { ...m, mutate, mutateAsync, checkingOutcome:');

  });
});

describe('the restart', () => {
  it('a sent intent for THIS principal is probed on mount; placed ends it, none re-opens it, in flight leaves it sent', () => {
    const recovery = body(HOOKS, 'export function useCheckoutRecovery()', 'export function useCart');
    expect(recovery).toContain("checkoutAttempt.resumeFor({ userId: session.userId, generation: session.generation })");
    expect(recovery).toContain("if (!pending || pending.state !== 'sent') return;");
    expect(recovery).toContain('settleSentIntent(pending.key, session, () => !current())');
    expect(recovery).toContain('const current = () => !cancelled && checkoutCurrent(session);');
    expect(recovery).toContain('requireCheckoutIntent(pending.key, session);');
    const placed = body(recovery, "if (probe.status === 'placed') {", "} else if (probe.status === 'none') {");
    expect(placed).toContain('checkoutAttempt.end(pending.key, session);');
    expect(placed).toContain('setPlacedOrderIds(probe.orderIds);');
    const none = recovery.slice(recovery.indexOf("} else if (probe.status === 'none') {"));
    expect(none).toContain('checkoutAttempt.markOpen(pending.key, session);');
    expect(none).not.toContain('checkoutAttempt.end(');
  });
  it('the cart screen holds the button while an intent is being resolved, and shows the two non-failure answers as facts', () => {
    expect(CART).toContain('const recovery = useCheckoutRecovery();');
    expect(CART).toContain('placeOrder.error instanceof CheckoutAlreadyPlacedError');
    expect(CART).toContain('placeOrder.error instanceof CheckoutInFlightError');
    expect((CART.match(/recovery\.recovering \|\| alreadyPlaced \|\| stillPlacing/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(CART).toContain('This order was already placed');
    expect(CART).toContain('This order is already being placed');
    // [AX372 R1] An unknown outcome reads as plain words while it is asked about, never as a failure.
    expect(CART).toContain('placeOrder.checkingOutcome || recovery.recovering || placeOrder.error instanceof CheckoutOutcomeUnknownError');
    expect(CART).toMatch(/: checkingOutcome\s*\? CHECKING_ORDER_MESSAGE/);
    expect(HOOKS).toContain(`export const CHECKING_ORDER_MESSAGE = "We're checking whether your order went through.";`);
  });
});

describe('the cart seam', () => {
  it('every cart change invalidates only its captured unsent intent through the ONE seam', () => {
    const seam = body(HOOKS, 'function invalidateCart(', 'export function useAddToCart');
    expect(seam).toContain('if (!checkoutCurrent(principal)) return;');
    expect(seam).toContain('checkoutAttempt.invalidateCart(principal);');
    expect(seam).not.toContain('checkoutAttempt.end(');
    const cartHooks = body(HOOKS, 'export function useAddToCart', 'export function useMySupportTickets');
    const direct = cartHooks.match(/invalidateQueries\(\{ queryKey: \['customer', 'cart'\]/g) ?? [];
    expect(direct).toHaveLength(0);
    expect((cartHooks.match(/return useCartMutation\(/g) ?? []).length).toBe(8);
    expect(seam).toContain('invalidateCart(qc, operation.principal)');
    expect(seam).toContain('const session = getAuthSessionSnapshot();');
    expect(seam).toContain('principal: session ? { userId: session.userId, generation: session.generation } : null');
    expect(seam).toContain('const session = requireAuthSessionForPrincipal(operation.principal);');
    expect(seam).toContain('await send(operation.payload, session)');
    expect(seam).not.toContain('onMutate: checkoutPrincipal');
  });
});

describe('the API client', () => {
  it('sends the key it is given and mints nothing of its own; the receipt probe asks by key', () => {
    const place = body(API, 'placeOrder: (', 'checkoutReceipt:');
    expect(place).toContain("headers: { 'Idempotency-Key': idempotencyKey }");
    expect(place).not.toMatch(/Math\.random|Date\.now/);
    expect(place).toContain('capturedAuthConfig(session, {');
    const probe = body(API, 'checkoutReceipt:', 'getNotifications:');
    expect(probe).toContain('/customer/checkout/receipts/${encodeURIComponent(idempotencyKey)}');
    expect(probe).toContain('capturedAuthConfig(session)');
  });
});
