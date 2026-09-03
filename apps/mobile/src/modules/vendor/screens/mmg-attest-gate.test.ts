import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canAttestPayment, paymentAttestBlockedReason } from '../../../lib/orderStatus';

// ---------------------------------------------------------------------------
// [W-25] "Payment received" on the store app is a person's WORD, and it was
// offered on almost every order: the predicate was "not captured and not
// terminal", so a FAILED, a REFUNDED and an unresolved payment each had a
// one-tap "received" with no amount and no reference. A tap on a reversed
// payment recaptured a refund.
//
// The predicate and the words now come from lib/orderStatus (one vocabulary,
// shared with the server's matrix). The mobile harness has no React Native
// renderer, so the screen half is a source contract — the same shape as the
// driver PIN gate and the pickup hand-over.
// ---------------------------------------------------------------------------

const screen = readFileSync(join(process.cwd(), 'src/modules/vendor/screens/VendorOps.tsx'), 'utf8');
const client = readFileSync(join(process.cwd(), 'src/services/api.ts'), 'utf8');
const hook = readFileSync(join(process.cwd(), 'src/hooks/vendorops.ts'), 'utf8');

describe('[W-25] the attestable set is the shared one', () => {
  it('only PENDING and AUTHORIZED are attestable; every reversed or unresolved state is not', () => {
    expect(canAttestPayment('PENDING')).toBe(true);
    expect(canAttestPayment('AUTHORIZED')).toBe(true);
    for (const s of ['CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN', 'EXPIRED', 'CANCELLED', '', null, undefined]) {
      expect(canAttestPayment(s), String(s)).toBe(false);
    }
  });

  it('every refused state has a sentence, and an attestable one has none to show', () => {
    for (const s of ['FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN', 'EXPIRED', 'CANCELLED']) {
      expect(paymentAttestBlockedReason(s), s).toBeTruthy();
    }
    expect(paymentAttestBlockedReason('PENDING')).toBeNull();
    expect(paymentAttestBlockedReason('CAPTURED')).toBeNull();
  });
});

describe('[W-25] the store screen asks the shared predicate, and sends the reference', () => {
  it('the button is gated on canAttestPayment, never on "not captured"', () => {
    expect(screen).toMatch(/canAttestPayment\(order\.paymentStatus\)/);
    // the old shape: any non-captured, non-terminal order offered the tap
    expect(screen).not.toMatch(/attestable = isMmg && !mmgPaid/);
  });

  it('a refused state shows its reason instead of going quiet', () => {
    expect(screen).toMatch(/paymentAttestBlockedReason\(order\.paymentStatus\)/);
    expect(screen).toMatch(/payBlockedReason/);
  });

  it('the reference is collected and carried all the way to the request', () => {
    expect(screen).toMatch(/MMG transaction reference/);
    expect(screen).toMatch(/onAction\('confirm-payment', mmgRef\.trim\(\)\)/);
    expect(screen).toMatch(/mmgRef\.trim\(\)\.length < 4/);
    expect(hook).toMatch(/confirmPayment\(id, code \?\? ''\)/);
    expect(client).toMatch(/confirmPayment: \(id: string, reference: string\)/);
    expect(client).toMatch(/\{ reference \}/);
  });
});
