import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [S1-6] The order screen is the customer's ONLY first-party door to "I did
// not pay". Read as source (the screen and the hooks import react-native,
// whose Flow entry vitest cannot parse), these pin that the door is wired:
// the server projection is parsed strictly, the card renders from it, "I
// didn't pay" is confirmed before it is sent, and the order refetches after.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));
const HOOKS = strip(readFileSync(new URL('../../../hooks/customer.ts', import.meta.url), 'utf8'));

describe('the order screen wires the customer\'s payment claim', () => {
  it('parses the server projection and renders the claim card from it', () => {
    expect(SCREEN).toMatch(/import \{ MmgPaymentClaimCard \} from '\.\.\/MmgPaymentClaimCard';/);
    expect(SCREEN).toMatch(/parseMmgClaimView\(o\.mmgClaim\)/);
    expect(SCREEN).toMatch(/<MmgPaymentClaimCard\b/);
  });

  it('declares the claim mutation with the other hooks — before any early return', () => {
    const hook = SCREEN.indexOf('useClaimMmgPayment()');
    const earlyReturn = SCREEN.indexOf('if (order.isError || !o)');
    expect(hook).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(earlyReturn);
  });

  // [R4 · F-PR1262-SOL-01] React Navigation reuses this screen for another
  // order. A confirmation carries the order it was opened on; the popup and
  // the send both go through the binding (customer.mmgClaim.test.ts runs it
  // through the real hook and request seam), in the very render the route
  // changes — not after a reset effect.
  it('"I didn\'t pay" goes through a confirmation bound to the order it was opened on', () => {
    expect(SCREEN).toMatch(/setPendingMmgClaim\(\{ orderId, action \}\)/);
    expect(SCREEN).toMatch(/const confirmingMmgClaim = boundMmgClaim\(pendingMmgClaim, orderId\);/);
    expect(SCREEN).toMatch(/visible=\{confirmingMmgClaim !== null\}/);
    const confirmBlock = SCREEN.slice(SCREEN.indexOf('visible={confirmingMmgClaim !== null}'));
    expect(confirmBlock).toMatch(/sendBoundMmgClaim\(pendingMmgClaim, orderId, \(claim\) =>/);
  });

  it('every claim the screen sends names its order: none rides on the render\'s order alone', () => {
    const sends = SCREEN.match(/claimPayment\.mutate\(\{[^}]*\}/g) ?? [];
    expect(sends.length).toBeGreaterThan(0);
    for (const send of sends) expect(send).toMatch(/\borderId\b/);
    expect(SCREEN).toMatch(/claimPayment\.mutate\(\{ orderId, paid: action\.paid \}/);
    expect(SCREEN).toMatch(/claimPayment\.mutate\(claim,/);
    expect(SCREEN).not.toMatch(/claimPayment\.mutate\(\{ paid:/);
  });

  it('a reused screen drops a pending confirmation with the rest of its order-local state', () => {
    // The [orderId] effect that clears the cancel preview is the order reset.
    const effects = SCREEN.split('}, [orderId]);').map((chunk) => chunk.slice(chunk.lastIndexOf('useEffect(() => {')));
    const reset = effects.filter((body) => body.includes('setCancelPreviewOrderId(null);'));
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatch(/setPendingMmgClaim\(null\);/);
  });

  it('the hook takes the order from the claim itself and refetches that order whether it landed or not', () => {
    const start = HOOKS.indexOf('export function useClaimMmgPayment()');
    expect(start).toBeGreaterThan(-1);
    const hook = HOOKS.slice(start, HOOKS.indexOf('\n}', start));
    expect(hook).toMatch(/mutationFn: \(\{ orderId, paid, reference \}/);
    expect(hook).toMatch(/customerApi\.claimOrderPayment\(orderId,/);
    expect(hook).toMatch(/onSettled: \(_data, _error, \{ orderId \}\) =>/);
    expect(hook).toMatch(/queryKey: customerKeys\.order\(orderId\)/);
  });
});
