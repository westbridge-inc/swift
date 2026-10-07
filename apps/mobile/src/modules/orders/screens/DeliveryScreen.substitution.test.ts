import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [L09 · M028] When the store proposes a substitute, the customer's order
// screen refreshes from the server at once (that wiring predates this change
// and is kept as a guard) and the swap card now says what approving changes:
// the total, paid options included, and the choices that do not come with the
// swap (read as source, as the other DeliveryScreen suites do: the screen
// imports react-native, which vitest cannot parse). The sentence itself runs
// for real in ../substitutionCopy.test.ts; the decision hook's refresh in
// hooks/customer.substitution.test.ts.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));

// The swap card, from its comment to its Approve button.
const CARD = SCREEN.slice(SCREEN.indexOf('{!terminal ? items'), SCREEN.indexOf('label="Approve swap"'));

describe('the order screen follows a substitution as it happens', () => {
  it('a proposal refreshes this order at once, and its card states what approving changes, from the server', () => {
    const handler = SCREEN.slice(SCREEN.indexOf('const onStatus = (payload: any) => {'), SCREEN.indexOf('const onConnect = () => {'));
    expect(handler).toContain('if (payload?.orderId !== orderId) return;');
    expect(handler).toContain('void order.refetch();');
    expect(SCREEN).toContain("s.on('order:substitution', onStatus);");
    expect(SCREEN).toContain("s.off('order:substitution', onStatus);");
    // The price change and the options note come from the server's swap view
    // (the approval's own formula), never from the substitute's price alone.
    expect(CARD).toContain(".filter((it: any) => it.subStatus === 'PENDING')");
    expect(CARD).toContain('{swapChangeText(it.substitution, o.paymentMethod) ? (');
    expect(CARD).toContain('{swapChangeText(it.substitution, o.paymentMethod)}');
  });

  it('the customer reads what approving changes before the buttons, and decides through the hook bound to this order', () => {
    expect(SCREEN).toContain("import { swapChangeText, swapDecisionPermissions } from '../substitutionCopy';");
    expect(CARD.indexOf('swapChangeText(it.substitution, o.paymentMethod)')).toBeGreaterThan(CARD.indexOf('Rejecting removes the item and lowers your total.'));
    expect(SCREEN).toContain('const decideSub = useDecideSubstitution(orderId);');
  });
});

it('both decision controls follow the permitted decisions, and MMG settlement guidance is shown', () => {
  expect(SCREEN).toContain('disabled={decideSub.isPending || !swapDecisionPermissions(it.substitution, o.paymentMethod).approve}');
  expect(SCREEN).toContain('disabled={decideSub.isPending || !swapDecisionPermissions(it.substitution, o.paymentMethod).reject}');
  expect(CARD).toContain('swapDecisionPermissions(it.substitution, o.paymentMethod).settlementGuidance');
});
