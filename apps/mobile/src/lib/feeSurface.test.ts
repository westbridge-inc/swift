import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feeSurfaceFor, framingProblem, FEE_FRAMING } from './feeSurface';

// Owner direction 2026-09-29 retires account numbers and agent instructions
// on every platform. The server's payActions is now the payment authority.

describe('what the fee screen may show, per store', () => {
  it('iOS keeps status and removes the retired instructions', () => {
    const ios = feeSurfaceFor('ios');
    expect(ios.showStatus).toBe(true);
    expect(ios.showAccountNumber).toBe(false);
    expect(ios.showPaymentSteps).toBe(false);
  });

  it('the account number is retired on every platform', () => {
    for (const platform of ['ios', 'android', 'web'] as const) expect(feeSurfaceFor(platform).showAccountNumber).toBe(false);
  });

  it('off methods never get placeholder instructions', () => {
    const ios = feeSurfaceFor('ios');
    expect(ios.alternative).toBeNull();
  });

  it('Android removes the retired steps too', () => {
    const android = feeSurfaceFor('android');
    expect(android.showPaymentSteps).toBe(false);
    expect(android.alternative).toBeNull();
  });

  it('the same MONEY on both — this is not two feature sets', () => {
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

  it('deprecated payment fields cannot be rendered', () => {
    expect(SRC).not.toMatch(/payCashSteps|sanFormatted|activationCopy|sub\.san\b/);
  });

  it('nothing branches on anything but the platform', () => {
    // The one thing that would turn a store-rules branch into reviewer
    // detection. DL-6, and a ban here is unrecoverable.
    const branch = SRC;
    for (const forbidden of ['userAgent', 'isReviewer', 'req.ip', 'headers[']) {
      expect(branch.includes(forbidden), `${forbidden} near the fee surface`).toBe(false);
    }
  });
});
