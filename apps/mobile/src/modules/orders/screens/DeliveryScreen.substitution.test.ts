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
    // [TRANSFORMED 17 Oct: the import gains swapDeadlineText. O-4 22 Oct: and the removal question's two helpers.]
    expect(SCREEN).toContain("import { isRemovalQuestion, removalChangeText, swapChangeText, swapDeadlineText, swapDecisionPermissions } from '../substitutionCopy';");
    expect(CARD.indexOf('swapChangeText(it.substitution, o.paymentMethod)')).toBeGreaterThan(CARD.indexOf('Rejecting removes the item and lowers your total.'));
    // [TRANSFORMED after #1707: the order travels with each decision, never the render's closure.]
    expect(SCREEN).toContain('const decideSub = useDecideSubstitution();');
    expect(SCREEN).toContain('decideSub.mutate({ orderId, lineId: it.id, approve: true })');
    expect(SCREEN).toContain('decideSub.mutate({ orderId, lineId: it.id, approve: false })');
  });
});

it('both decision controls follow the permitted decisions, and MMG settlement guidance is shown', () => {
  expect(SCREEN).toContain('disabled={decideSub.isPending || !swapDecisionPermissions(it.substitution, o.paymentMethod).approve}');
  expect(SCREEN).toContain('disabled={decideSub.isPending || !swapDecisionPermissions(it.substitution, o.paymentMethod).reject}');
  expect(CARD).toContain('swapDecisionPermissions(it.substitution, o.paymentMethod).settlementGuidance');
});

// [SUBSTITUTION · owner 17 Oct 2026] The card says how long the question waits and what happens
// without an answer, from the server's deadline (the sentence runs in ../substitutionCopy.test.ts),
// and says it before the buttons.
it('the swap card states the deadline and the no-answer outcome before the buttons', () => {
  expect(CARD).toContain('{swapDeadlineText(it.substitution) ? (');
  expect(CARD).toContain('{swapDeadlineText(it.substitution)}');
});

// [O-4 · owner 22 Oct 2026] Nothing to swap, asked before the store accepted: the customer continues
// without the item (the server lowers the total) or cancels the order through the screen's own
// re-checked cancel flow (free while the store has not accepted).
it('a removal question gets its own card: "Continue without it" answers yes, "Cancel order" opens the checked cancel', () => {
  const removal = SCREEN.slice(SCREEN.indexOf('isRemovalQuestion(it.substitution) ? ('), SCREEN.indexOf('label="Approve swap"'));
  expect(removal).toContain('is out of stock');
  expect(removal).toContain('removalChangeText(it.substitution)');
  expect(removal).toContain('swapDeadlineText(it.substitution)');
  const yes = removal.slice(removal.indexOf('label="Continue without it"'), removal.indexOf('label="Cancel order"'));
  expect(yes).toContain('decideSub.mutate({ orderId, lineId: it.id, approve: true })');
  expect(yes).toContain('!swapDecisionPermissions(it.substitution, o.paymentMethod).approve');
  const cancel = removal.slice(removal.indexOf('label="Cancel order"'));
  expect(cancel).toContain('disabled={!o.canCancel}');
  expect(cancel).toContain('void openCancelConfirmation();');
  expect(removal).not.toContain('approve: false');
});
