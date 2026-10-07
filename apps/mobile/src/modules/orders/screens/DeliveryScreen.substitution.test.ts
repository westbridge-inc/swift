import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [L09 · M028] When the store proposes a substitute, the customer's order
// screen refreshes from the server at once (read as source, as the other
// DeliveryScreen suites do: the screen imports react-native, which vitest
// cannot parse). The decision hook's refresh runs for real in
// hooks/customer.substitution.test.ts.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));

describe('the order screen follows a substitution as it happens', () => {
  it('the order:substitution event refetches this order, and the listener is removed on leave', () => {
    const handler = SCREEN.slice(SCREEN.indexOf('const onStatus = (payload: any) => {'), SCREEN.indexOf('const onConnect = () => {'));
    expect(handler).toContain('if (payload?.orderId !== orderId) return;');
    expect(handler).toContain('void order.refetch();');
    expect(SCREEN).toContain("s.on('order:substitution', onStatus);");
    expect(SCREEN).toContain("s.off('order:substitution', onStatus);");
  });

  it('the screen decides through the hook bound to this order', () => {
    expect(SCREEN).toContain('const decideSub = useDecideSubstitution(orderId);');
  });
});
