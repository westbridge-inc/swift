import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feeSurfaceFor, framingProblem, FEE_FRAMING } from './feeSurface';

// ---------------------------------------------------------------------------
// [Apple 3.1.1 / 3.1.3(e)] The weekly partner fee, on an iPhone.
//
// The fee buys the right to operate a real business: receive orders, deliver
// physical goods, keep 100% of every fare and tip. 3.1.3(e) says services
// consumed outside the app must use payment methods OTHER than IAP — so
// Apple's own purchase system is the wrong instrument here, not a missing one.
//
// What draws a reviewer's eye is not the payment, it is the reading. A screen
// carrying numbered steps for sending money to a merchant account can be read
// as steering a purchase out of the app. The same screen showing what is owed
// and when reads as an account statement.
// ---------------------------------------------------------------------------

describe('what the fee screen may show, per store', () => {
  it('iOS keeps every FACT and drops the instructions', () => {
    const ios = feeSurfaceFor('ios');
    expect(ios.showStatus).toBe(true);
    expect(ios.showAccountNumber).toBe(true);
    expect(ios.showPaymentSteps).toBe(false);
  });

  it('the account number stays — it identifies them, it is not a payment method', () => {
    // It plays the role a customer number plays on a utility bill, and it is
    // already on their receipts and statements. Hiding a fact about their own
    // account to satisfy a rule about purchases makes the screen useless
    // without making it safer.
    expect(feeSurfaceFor('ios').showAccountNumber).toBe(true);
  });

  it('a partner is never left with no way to pay', () => {
    // The failure mode of over-correcting: remove the steps, say nothing, and
    // a vendor who does not know how to pay stops being a vendor.
    const ios = feeSurfaceFor('ios');
    expect(ios.alternative, 'the steps are hidden and nothing replaces them').toBeTruthy();
    expect(ios.alternative!.length).toBeGreaterThan(40);
  });

  it('Android keeps the steps — Play has no equivalent rule', () => {
    const android = feeSurfaceFor('android');
    expect(android.showPaymentSteps).toBe(true);
    expect(android.alternative).toBeNull();
  });

  it('the same MONEY on both — this is not two feature sets', () => {
    // DL-6: nothing may branch on who is looking. This branches on the STORE'S
    // published rules, and the amounts, dates and account number are identical.
    const [ios, android] = [feeSurfaceFor('ios'), feeSurfaceFor('android')];
    expect(ios.showStatus).toBe(android.showStatus);
    expect(ios.showAccountNumber).toBe(android.showAccountNumber);
  });
});

describe('the framing decides which guideline applies', () => {
  it('the standing copy describes a business, not a tier of an app', () => {
    expect(framingProblem(FEE_FRAMING)).toBeNull();
    expect(FEE_FRAMING).toMatch(/keep 100%/i);
  });

  it('rejects the words that make this look like an in-app purchase', () => {
    // "Upgrade" and "unlock" describe buying a version of an app — 3.1.1, IAP
    // required. The words are the only evidence a reviewer has about which
    // kind of thing this is.
    for (const bad of ['Upgrade to Pro', 'Unlock more orders', 'Go Premium', 'Subscribe now to continue']) {
      expect(framingProblem(bad), bad).not.toBeNull();
    }
  });

  it('says what to write instead, not just that it is wrong', () => {
    expect(framingProblem('Upgrade now')).toMatch(/real business/i);
  });
});

describe('the surface as rendered', () => {
  const SRC = readFileSync(
    join(process.cwd(), 'src/components/billing/BillingSurfaces.tsx'),
    'utf8',
  );

  it('the payment steps are gated by the surface, not rendered unconditionally', () => {
    expect(SRC).toMatch(/feeSurfaceFor/);
    expect(SRC).toMatch(/showPaymentSteps/);
  });

  it('nothing branches on anything but the platform', () => {
    // The one thing that would turn a store-rules branch into reviewer
    // detection. DL-6, and a ban here is unrecoverable.
    const branch = SRC.slice(SRC.indexOf('feeSurfaceFor'));
    for (const forbidden of ['userAgent', 'isReviewer', 'req.ip', 'headers[']) {
      expect(branch.includes(forbidden), `${forbidden} near the fee surface`).toBe(false);
    }
  });
});
