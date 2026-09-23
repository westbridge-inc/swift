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
    const hook = SCREEN.indexOf('useClaimMmgPayment(orderId)');
    const earlyReturn = SCREEN.indexOf('if (order.isError || !o)');
    expect(hook).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(earlyReturn);
  });

  it('"I didn\'t pay" goes through a confirmation; only the confirmed choice is sent', () => {
    expect(SCREEN).toMatch(/setPendingMmgClaim\(action\)/);
    expect(SCREEN).toMatch(/visible=\{pendingMmgClaim !== null\}/);
    const confirmBlock = SCREEN.slice(SCREEN.indexOf('visible={pendingMmgClaim !== null}'));
    expect(confirmBlock).toMatch(/claimPayment\.mutate\(\{ paid: pendingMmgClaim\.paid \}/);
  });

  it('the hook refetches the order whether the claim landed or not', () => {
    const start = HOOKS.indexOf('export function useClaimMmgPayment(orderId: string)');
    expect(start).toBeGreaterThan(-1);
    const hook = HOOKS.slice(start, HOOKS.indexOf('\n}', start));
    expect(hook).toMatch(/customerApi\.claimOrderPayment\(orderId,/);
    expect(hook).toMatch(/onSettled:/);
    expect(hook).toMatch(/queryKey: customerKeys\.order\(orderId\)/);
  });
});
