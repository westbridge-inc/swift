import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { money } from '../../../lib/money';

// [L09 · price lock] Execute the actual order callback and native-alert
// effect: a refetch while the confirmation is open must never replace the
// prices it showed. The alert shows whole GYD like every cart figure; what is
// submitted is the reviewed quote itself, to the cent.
it.each([1500, 1500.25])('pickup confirmation submits the reviewed quote %s, not one refetched while it is open', (reviewed) => {
  const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const screen = parse('src/modules/cart/screens/CartScreen.tsx');
  const helpers = parse('src/modules/cart/cartQuote.ts');
  const find = (file: ts.SourceFile, predicate: (n: ts.Node) => boolean) => {
    let result: ts.Node | undefined;
    const visit = (node: ts.Node) => { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); };
    visit(file);
    if (!result) throw new Error('Source node not found');
    return result.getText(file);
  };
  const onOrder = find(screen, n => ts.isVariableDeclaration(n) && n.name.getText(screen) === 'onOrder');
  const effect = find(screen, n => ts.isCallExpression(n) && n.expression.getText(screen) === 'useEffect' && n.getText(screen).includes('const pickupTotal = Number(pickupQuote.data.totalAmount);'));
  let alert: any;
  let submitted: any;
  const context = vm.createContext({
    exports: {}, pickup: false, pricing: {},
    c: { totalAmount: 2000, items: [{ id: 'line-1', vendorId: 'store-1', customerPrice: 1500 }] },
    pickupQuote: { isFetching: false, isPlaceholderData: false, isError: false, data: { totalAmount: reviewed, items: [{ id: 'line-1', vendorId: 'store-1', customerPrice: reviewed }] } },
    effectivePaySelection: {}, paymentCapabilities: {}, checkoutPaymentMethod: () => 'CASH',
    apptPayload: [], instructions: '', placeOrder: { mutate: (body: any) => { submitted = body; } },
    confirmPickup: true, pickupAttempt: 1, pickupConfirmShown: { current: false }, onOrderLatest: { current: null },
    setConfirmPickup: () => {}, money,
    Alert: { alert: (_title: string, message: string, buttons: any) => { alert = { message, buttons }; } },
    useEffect: (callback: () => void) => callback(),
  });
  const run = (source: string) => vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  for (const name of ['pricesAsSeen', 'pricedTip', 'quoteStoreIds']) run(find(helpers, n => ts.isFunctionDeclaration(n) && n.name?.text === name).replace(/^export /, ''));
  const install = () => run('globalThis.onOrderLatest.current = (' + onOrder.slice(onOrder.indexOf('=') + 1) + ');');
  install(); run(effect);
  expect(alert.message).toContain(`Your pickup total is ${money(reviewed)}.`);
  // A reconnect refetches the pickup quote at the store's new price while the
  // alert is still open.
  context['pickupQuote'] = { ...context['pickupQuote'], data: { totalAmount: 1800, items: [{ id: 'line-1', vendorId: 'store-1', customerPrice: 1800 }] } };
  context['c'] = { totalAmount: 2300, items: [{ id: 'line-1', vendorId: 'store-1', customerPrice: 1800 }] };
  install();
  alert.buttons.find((button: any) => button.text === 'Confirm pickup order').onPress();
  expect(submitted.expectedTotal).toBe(reviewed);
  expect(submitted.expectedLines).toEqual([{ lineId: 'line-1', unitPrice: reviewed }]);
  expect(submitted.fulfillmentSelections).toEqual({ 'store-1': 'PICKUP' });
  expect(submitted.tipAmount).toBe(0);
});
