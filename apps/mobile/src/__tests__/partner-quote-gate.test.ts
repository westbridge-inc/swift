import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [PR1270-S2-04 / H7] The price on the door is a condition of the door.
//
// A partner may agree to "a flat weekly fee" only while the fee is on the
// screen: fetched successfully, for the vehicle or business type they picked,
// and recently. The gate itself is a pure function (lib/partnerPricing.test.ts
// proves it); these read the two signup screens as text and pin that the gate
// is what their submit control is wired to, because a gate that exists but is
// not wired is the exact shape the review found.
//
// The preview surfaces get the same honesty: no quote means "unavailable",
// never a sample store that is "covered" for $0.
// ---------------------------------------------------------------------------

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('[PR1270-S2-04] signup commits only to a fetched, current, on-screen quote', () => {
  it.each([
    ['src/modules/mover/screens/MoverOnboardingScreen.tsx', 'moverQuote(p, vt)'],
    ['src/modules/vendor/screens/BusinessSetup.tsx', 'vendorQuote(p, type)'],
  ])('%s gates its submit control on the quote gate', (file, pick) => {
    const s = src(file);
    expect(s).toMatch(/import \{[^}]*\bquoteGate\b[^}]*\} from '(\.\.\/)+lib\/partnerPricing'/);
    // The signup surface reads a FRESH list — never the hour-old cache a preview may use.
    expect(s).toMatch(/usePartnerPricing\([^)]*\{ fresh: true \}\)/);
    expect(s).toContain(`quoteGate(pricing, (p) => ${pick})`);
    expect(s).toMatch(/disabled=\{!gate\.ok/);
    expect(s).toMatch(/QUOTE_GATE_COPY\[gate\.why\]/);
    // The submit handler restates the gate, so no call site can bypass the button.
    expect(s).toMatch(/if \(!gate\.ok\) return;/);
  });

  it('the price card hides a quote it cannot confirm, so the card and the gate never disagree', () => {
    expect(src('src/components/onboarding/PricingCard.tsx')).toMatch(/if \(!p \|\| pricing\.isError\) return null;/);
  });

  it('a fresh read is fresh: no stale window, refetched on every mount and every minute on screen', () => {
    const hook = src('src/hooks/partnerPricing.ts');
    expect(hook).toContain('staleTime: fresh ? 0 : HOUR_MS');
    expect(hook).toContain("refetchOnMount: fresh ? 'always' : true");
    expect(hook).toContain('refetchInterval: fresh ? MINUTE_MS : false');
  });
});

describe('[H7] a preview with no quote says so — never $0, never covered', () => {
  it('the vendor Swift Number hero renders a dash for an unknown amount', () => {
    const screen = src('src/modules/vendor/screens/VendorSwiftNumberScreen.tsx');
    expect(screen).toContain('moneyOrDash(state.amountGyd)');
    expect(screen).not.toMatch(/\{money\(state\.amountGyd\)\}/);
  });

  it.each(['src/hooks/vendorops.ts', 'src/hooks/mover.ts'])('%s carries the price list\'s loading and error state into the preview subscription', (file) => {
    const s = src(file);
    expect(s).toContain('isLoading: sample == null && pricing.isPending === true');
    expect(s).toContain('isError: sample == null && pricing.isError === true');
  });
});
