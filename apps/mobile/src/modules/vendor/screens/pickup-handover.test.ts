import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [MOB-050 · A-15] THE COUNTER HAND-OVER, ON THE STORE'S SIDE.
//
// A collection code proves the person at the counter is the person who
// ordered. It works only if the VERIFIER never holds it: the customer reads it
// out, the store types it, the server compares.
//
// The store app did the opposite of both halves. It PRINTED the customer's
// code on the order board and on the order screen, which makes the check prove
// nothing. And its "Mark picked up" button sent no code at all, while the
// server has required one since SWIFT-077 — so every tap was refused with
// MISSING_PICKUP_CODE, and the screen rendered none of the server's errors.
// The result was a button that could not succeed and did not say why.
//
// The mobile harness has no React Native renderer, so this is a source-level
// contract, the same shape as the driver PIN gate at
// src/modules/mover/screens/pin-gate.test.ts.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const detail = read('src/modules/vendor/screens/VendorOrderDetailScreen.tsx');
const board = read('src/modules/vendor/screens/VendorOps.tsx');
const hook = read('src/hooks/vendorops.ts');
const api = read('src/services/api.ts');

describe('[MOB-050] the store types the code, and never reads it', () => {
  it('no vendor surface renders the customer’s collection code', () => {
    // the value itself must not reach the store's screen in either place
    expect(detail).not.toMatch(/\{order\.pickupCode\}/);
    expect(board).not.toMatch(/\{order\.pickupCode\}/);
    // and neither screen reads the field for display at all
    expect(board).not.toMatch(/order\.pickupCode/);
  });

  it('the order screen collects the code with the same ceremony as the driver PIN', () => {
    expect(detail).toMatch(/<CodeInput/);
    expect(detail).toMatch(/value=\{pickupCode\}/);
    expect(detail).toMatch(/length=\{PICKUP_CODE_LENGTH\}/);
    // the entry shakes on a refusal, exactly like the ride PIN
    expect(detail).toMatch(/error=\{orderAction\.isError\}/);
  });

  it('the code is SENT with the completion, not dropped', () => {
    expect(detail).toMatch(/action: 'complete-pickup'|action === 'complete-pickup'/);
    expect(detail).toMatch(/code: pickupCode/);
    // the hook and the client have always been able to carry it
    expect(hook).toMatch(/completePickup\(id, code\)/);
    expect(api).toMatch(/completePickup/);
  });

  it('the button waits for a FULL code — a truncated entry burns an attempt at the counter', () => {
    expect(detail).toMatch(/pickupCode\.length < PICKUP_CODE_LENGTH/);
    // the old bug shape: a hardcoded digit against a 6-digit code
    expect(detail).not.toMatch(/pickupCode\.length < \d/);
    expect(detail).toMatch(/export const PICKUP_CODE_LENGTH = 6;/);
  });

  it('the server’s refusal is rendered, never swallowed', () => {
    expect(detail).toMatch(/orderAction\.isError \?/);
    expect(detail).toMatch(/orderAction\.error as Error/);
  });

  it('a missing order id is an error, not a screen that loads forever', () => {
    expect(detail).toMatch(/if \(!orderId\) \{/);
    // the old shape folded it into the loading branch
    expect(detail).not.toMatch(/isLoading \|\| !orderId/);
  });
});
