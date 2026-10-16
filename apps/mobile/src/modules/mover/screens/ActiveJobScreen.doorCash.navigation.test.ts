/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [L02 · row 56 · owner rulings 5 + 7 Oct] The REAL rider ActiveJobScreen at a
// cash door, drawn by a real React renderer. The hooks are fakes: the active
// job is the server's payload (door authority with the amount due and the
// version), and the rider action records exactly what would be sent, then
// answers as the server (#1542) answers. Asserted:
//   - the amount due on screen is the server's;
//   - nothing is sent until the rider typed, reviewed and confirmed;
//   - each statement sends exactly the fields the handover route reads
//     (outcome, collectedAmount, cashReturned / handedOverShort, the door's
//     version; the door code only with a hand-over);
//   - the rider reads back the SERVER's figures (recorded / held), and its
//     refusals in its own words;
//   - a goods order going back to the store shows no door, and reads back the
//     partial cash the server recorded.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  job: null as any,
  riderAct: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  handlers: null as null | { onSuccess: (res: unknown) => void; onError: (err: unknown) => void },
  input: null as null | { onChangeText: (t: string) => void; value: string },
  code: null as null | { onChange: (t: string) => void },
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() },
  refetch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
    Platform: { OS: 'ios' },
    Linking: { openURL: vi.fn() },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-maps', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    __esModule: true,
    default: (p: any) => h('div', { 'data-map': '' }, p.children),
    Marker: (p: any) => h('div', { 'data-marker': p.title ?? '' }),
    Polyline: () => null,
    PROVIDER_DEFAULT: 'default',
  };
});
vi.mock('@gorhom/bottom-sheet', async () => {
  const R = await import('react');
  return { __esModule: true, default: (p: any) => R.createElement('section', null, p.children), BottomSheetScrollView: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: vi.fn(), launchCameraAsync: vi.fn() }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const Box = (p: any) => h('div', a11y(p), p.children);
  const T = (p: any) => h('span', a11y(p), p.children);
  return {
    T, Eyebrow: T, PopupTitle: T, Screen: Box, DecorativeIcon: Box,
    PillButton: (p: any) => h('button', { type: 'button', 'data-testid': p.testID, 'aria-label': p.label, disabled: !!(p.disabled || p.loading), 'data-loading': p.loading ? 'true' : undefined, onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label),
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    EmptyState: (p: any) => h('div', null, p.title),
    StatusRail: () => null, LockIn: (p: any) => h('div', null, p.label), TonePill: (p: any) => h('span', null, p.label),
    // The door code boxes: only whether they read as refused matters here.
    CodeInput: (p: any) => {
      fx.code = p;
      return h('div', { 'data-testid': 'door-code', 'data-error': String(!!p.error) });
    },
    LabeledInput: (p: any) => {
      fx.input = p;
      return h('input', { 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, value: p.value, readOnly: true, 'data-error': p.error ?? '' });
    },
    ChoiceChip: (p: any) => h('button', { type: 'button', 'aria-label': p.label, 'aria-pressed': p.active ? 'true' : 'false', onClick: p.onPress }, p.label),
    cardShadow: {}, lockInButtonStyle: () => ({}),
  };
});
vi.mock('../../../kit/controls', () => ({ Stars: () => null }));
vi.mock('../../../kit/toast', () => ({ toast: fx.toast }));
vi.mock('../../../hooks', () => ({
  useMoverKind: () => ({ kind: 'RIDER' }),
  useActiveJob: () => ({ data: fx.job, refetch: fx.refetch, isFetching: false }),
  useActiveJobs: () => ({ legs: fx.job ? [fx.job] : [], run: null }),
  useDriverAction: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRiderAction: () => fx.riderAct,
  useRateCustomer: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierProof: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierCollect: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierPickupProof: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierReturn: () => ({ mutate: vi.fn(), isPending: false }),
  useCourierReturnProof: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../hooks/mover', () => ({ uploadHandoverPhoto: vi.fn(), useTaxiStopAction: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../CustodyRecoverySection', async () => {
  const R = await import('react');
  return { CustodyRecoverySection: () => R.createElement('div', { 'data-testid': 'custody-recovery' }) };
});
vi.mock('../../safety/SosCeremony', () => ({ SosCeremony: () => null }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }) }));
vi.mock('../../../stores/locationStore', () => ({ useLocationStore: () => ({ latitude: 6.81, longitude: -58.15, status: 'granted' }) }));
vi.mock('../../../lib/haptics', () => ({ haptic: { success: vi.fn(), failure: vi.fn(), commit: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../../services/emergencyPolicy', () => ({ currentMarketDial: () => ({ kind: 'manual' }), emergencyDialCopy: () => '', previewEmergencyDial: () => null }));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (select: (s: { countryCode: string }) => unknown) => select({ countryCode: 'GY' }),
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionForPrincipal: vi.fn(),
  requireAuthSessionSnapshot: vi.fn(),
}));

import { ActiveJobScreen } from './ActiveJobScreen';

/** A goods delivery at the customer's door, cash rail, as GET /rider/orders/active sends it. */
function cashDoorJob(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-cash-1',
    orderNumber: 'SW-1001',
    orderType: 'DELIVERY',
    status: 'ARRIVED',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    totalAmount: 2500,
    deliveryFee: 500,
    tipAmount: 0,
    pickupLat: 6.80, pickupLng: -58.16, deliveryLat: 6.82, deliveryLng: -58.14,
    vendor: { name: 'Corner Shop' },
    customer: { firstName: 'Asha' },
    handover: {
      policy: 'mismatch-1', rail: 'CASH', paymentState: 'PENDING', custodyState: 'ARRIVED',
      amount: 2500, currency: 'GYD', version: 'door-v1', permitted: 'COLLECT_CASH_THEN_DELIVER', blockReason: null,
    },
    ...over,
  };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const navigation = { navigate: fx.navigate, goBack: vi.fn() };

async function render(job: unknown) {
  fx.job = job;
  await act(async () => root.render(React.createElement(ActiveJobScreen, { navigation })));
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const text = () => host.textContent ?? '';
const dialog = () => host.querySelector('[role="dialog"]') as HTMLElement | null;
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttonNamed = (name: string, scope: Element = host) => Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === name) ?? null;
async function click(el: Element | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
}
async function type(value: string) {
  expect(fx.input, 'the amount field is on screen').toBeTruthy();
  await act(async () => { fx.input!.onChangeText(value); });
}
async function typeDoorCode(value: string) {
  expect(fx.code, 'the door code boxes are on screen').toBeTruthy();
  await act(async () => { fx.code!.onChange(value); });
}
async function answer(kind: 'success' | 'error', payload: unknown) {
  expect(fx.handlers, 'a request was sent').toBeTruthy();
  await act(async () => { kind === 'success' ? fx.handlers!.onSuccess(payload) : fx.handlers!.onError(payload); });
}
const refusal = (code: string, message: string) => ({ response: { status: 409, data: { success: false, error: { code, message } } } });

beforeEach(() => {
  vi.clearAllMocks();
  fx.handlers = null;
  fx.input = null;
  fx.code = null;
  fx.riderAct.isPending = false;
  fx.riderAct.isError = false;
  fx.riderAct.error = null;
  fx.riderAct.mutate.mockImplementation((_vars: unknown, handlers: any) => { fx.handlers = handlers; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the cash door shows the server’s amount due', () => {
  it('reads the door authority’s amount, in GYD, and offers the two honest outcomes', async () => {
    await render(cashDoorJob({ totalAmount: 9999 })); // the authority wins over a stale row figure
    expect(byTestId('door-cash-due')?.textContent).toBe('Cash due at the door (GYD)$2,500');
    expect(buttonNamed('Record cash & hand over')).toBeTruthy();
    expect(buttonNamed("Customer can't pay in full")).toBeTruthy();
    expect(buttonNamed("Customer didn't pay")).toBeTruthy();
    // The old one-tap completion is gone: nothing completes without a stated amount.
    expect(buttonNamed('Confirm payment & hand over')).toBeNull();
  });
});

describe('paid in full: type, review, confirm', () => {
  it('sends nothing until confirmed, then exactly the paid statement with the code and the door version', async () => {
    await render(cashDoorJob());
    await typeDoorCode('482913');
    await click(buttonNamed('Record cash & hand over'));
    expect(dialog()?.textContent).toContain('How much cash did you take?');
    expect(dialog()?.textContent).toContain('Due for this order: $2,500 (GYD).');
    // Review stays shut until a whole-GYD amount is typed.
    expect(byTestId('door-cash-review')?.hasAttribute('disabled')).toBe(true);
    await type('25.50');
    expect(byTestId('door-cash-amount')?.getAttribute('data-error')).toBe('Whole Guyana dollars only, like 2500.');
    expect(byTestId('door-cash-review')?.hasAttribute('disabled')).toBe(true);
    await type('2,500');
    await click(byTestId('door-cash-review'));
    expect(dialog()?.textContent).toContain('Record the cash and hand over?');
    expect(dialog()?.textContent).toContain('Due$2,500');
    expect(dialog()?.textContent).toContain('You took$2,500');
    expect(fx.riderAct.mutate).not.toHaveBeenCalled();

    await click(byTestId('door-cash-confirm'));
    expect(fx.riderAct.mutate).toHaveBeenCalledTimes(1);
    expect(fx.riderAct.mutate.mock.calls[0]![0]).toEqual({
      id: 'ord-cash-1', action: 'handover', outcome: 'paid', collectedAmount: 2500, pin: '482913', handoverVersion: 'door-v1',
    });
  });

  it('says so while Swift records it, and reads back the server’s figures once it has', async () => {
    await render(cashDoorJob());
    await click(buttonNamed('Record cash & hand over'));
    await type('2500');
    await click(byTestId('door-cash-review'));
    await click(byTestId('door-cash-confirm'));
    fx.riderAct.isPending = true;
    await render(fx.job);
    expect(dialog()?.textContent).toContain('Recording with Swift — keep this screen open.');
    expect(byTestId('door-cash-confirm')?.getAttribute('data-loading')).toBe('true');

    fx.riderAct.isPending = false;
    await answer('success', { orderId: 'ord-cash-1', status: 'DELIVERED', claim: null, cash: { due: 2500, collected: 2500, shortfall: 0, heldForReview: false } });
    expect(fx.toast.success).toHaveBeenCalledWith('Cash recorded', '$2,500 collected of $2,500 due. Delivery complete.');
    expect(dialog()).toBeNull();
  });

  it('a retry the server answers from what it already wrote claims no amount', async () => {
    await render(cashDoorJob());
    await click(buttonNamed('Record cash & hand over'));
    await type('2500');
    await click(byTestId('door-cash-review'));
    await click(byTestId('door-cash-confirm'));
    await answer('success', { orderId: 'ord-cash-1', status: 'DELIVERED', claim: null });
    expect(fx.toast.success).toHaveBeenCalledWith('Delivery complete', 'Swift had already recorded this hand-over.');
  });

  it('an amount over the total comes back in the server’s words, with the entry kept to correct', async () => {
    await render(cashDoorJob());
    await click(buttonNamed('Record cash & hand over'));
    await type('3000');
    await click(byTestId('door-cash-review'));
    await click(byTestId('door-cash-confirm'));
    await answer('error', refusal('CASH_OVER_DUE', 'This order is GY$2,500. Record only the cash you took for it, never more — give any extra back to the customer.'));
    expect(byTestId('door-cash-refusal')?.textContent).toBe('This order is GY$2,500. Record only the cash you took for it, never more — give any extra back to the customer.');
    expect(dialog()?.textContent).toContain('How much cash did you take?');
    expect(fx.input?.value).toBe('3000');
    expect(fx.toast.success).not.toHaveBeenCalled();
  });

  it('no answer at all is never shown as recorded', async () => {
    await render(cashDoorJob());
    await click(buttonNamed('Record cash & hand over'));
    await type('2500');
    await click(byTestId('door-cash-review'));
    await click(byTestId('door-cash-confirm'));
    await answer('error', new Error('Network Error'));
    expect(byTestId('door-cash-refusal')?.textContent).toContain('No answer from Swift, so this may not be recorded yet.');
    expect(dialog()).toBeTruthy();
    expect(fx.toast.success).not.toHaveBeenCalled();
    expect(fx.toast.show).not.toHaveBeenCalled();
  });

  it('a wrong door code closes the popup and is answered on the screen', async () => {
    await render(cashDoorJob());
    await click(buttonNamed('Record cash & hand over'));
    await type('2500');
    await click(byTestId('door-cash-review'));
    await click(byTestId('door-cash-confirm'));
    await answer('error', refusal('INVALID_PIN', 'That PIN does not match. 4 attempt(s) remaining.'));
    expect(dialog()).toBeNull();
    expect(fx.toast.error).toHaveBeenCalledWith('That PIN does not match. 4 attempt(s) remaining.');
  });

  it('a stale door refreshes, and the popup says why in the server’s words', async () => {
    await render(cashDoorJob());
    await click(buttonNamed('Record cash & hand over'));
    await type('2500');
    await click(byTestId('door-cash-review'));
    await click(byTestId('door-cash-confirm'));
    await answer('error', refusal('HANDOVER_STALE', 'This order changed since the screen was loaded — refresh before handing over.'));
    expect(fx.refetch).toHaveBeenCalled();
    expect(byTestId('door-cash-refusal')?.textContent).toBe('This order changed since the screen was loaded — refresh before handing over.');
  });
});

describe('short at the door: the server refuses the hand-over and offers the honest ways on', () => {
  async function shortRefused() {
    await render(cashDoorJob());
    await typeDoorCode('482913');
    await click(buttonNamed('Record cash & hand over'));
    await type('1000');
    await click(byTestId('door-cash-review'));
    await click(byTestId('door-cash-confirm'));
    await answer('error', refusal('CASH_SHORT_NO_HANDOVER', 'Do not hand over: the customer must pay the full GY$2,500.'));
    expect(byTestId('door-cash-refusal')?.textContent).toBe('Do not hand over: the customer must pay the full GY$2,500.');
    fx.riderAct.mutate.mockClear();
    fx.handlers = null;
  }

  it('can’t pay in full + cash given back: short_payment, the amount, cashReturned true, NO door code', async () => {
    await shortRefused();
    await click(buttonNamed("Customer can't pay in full", dialog()!));
    expect(dialog()?.textContent).toContain("Don't hand the order over: it goes back to the store.");
    expect(fx.input?.value).toBe('1000');
    // Partial cash taken: the rider must say whether it was handed back.
    expect(byTestId('door-cash-review')?.hasAttribute('disabled')).toBe(true);
    await click(buttonNamed('I gave it back'));
    await click(byTestId('door-cash-review'));
    expect(dialog()?.textContent).toContain('Send the order back to the store?');
    expect(dialog()?.textContent).toContain('Customer gave you$1,000');
    expect(dialog()?.textContent).toContain('That cashGiven back');
    await click(byTestId('door-cash-confirm'));
    expect(fx.riderAct.mutate.mock.calls[0]![0]).toEqual({
      id: 'ord-cash-1', action: 'handover', outcome: 'short_payment', collectedAmount: 1000, cashReturned: true, handoverVersion: 'door-v1',
    });
    await answer('success', { orderId: 'ord-cash-1', status: 'RETURNING', claim: null, cashReturn: { amount: 1000, status: 'RETURNED', heldForReview: false } });
    expect(fx.toast.success).toHaveBeenCalledWith('Recorded: cash given back', "You gave the customer's $1,000 back at the door. Take the order back to the store.");
  });

  it('cash not given back: cashReturned false, and the rider reads that they still hold it (held, not resolved)', async () => {
    await shortRefused();
    await click(buttonNamed("Customer can't pay in full", dialog()!));
    await click(buttonNamed("I couldn't"));
    await click(byTestId('door-cash-review'));
    expect(dialog()?.textContent).toContain('That cashStill with you');
    expect(dialog()?.textContent).toContain('operations follow up with you to return it');
    await click(byTestId('door-cash-confirm'));
    expect(fx.riderAct.mutate.mock.calls[0]![0]).toMatchObject({ outcome: 'short_payment', collectedAmount: 1000, cashReturned: false });
    expect(fx.riderAct.mutate.mock.calls[0]![0]).not.toHaveProperty('pin');
    await answer('success', { orderId: 'ord-cash-1', status: 'RETURNING', claim: null, cashReturn: { amount: 1000, status: 'HELD', heldForReview: true } });
    expect(fx.toast.show).toHaveBeenCalledWith('Recorded: you still hold the cash', "You still hold $1,000 of the customer's cash. Operations will follow up with you to return it. Take the order back to the store.");
    expect(fx.toast.success).not.toHaveBeenCalled();
  });

  it('already handed over: paid + handedOverShort with the code; the shortfall shown is the SERVER’s figure', async () => {
    await shortRefused();
    await click(buttonNamed('I already handed the order over', dialog()!));
    expect(dialog()?.textContent).toContain('the difference is yours to bear; Swift deducts nothing from anyone');
    await click(byTestId('door-cash-confirm'));
    expect(fx.riderAct.mutate.mock.calls[0]![0]).toEqual({
      id: 'ord-cash-1', action: 'handover', outcome: 'paid', collectedAmount: 1000, handedOverShort: true, pin: '482913', handoverVersion: 'door-v1',
    });
    // A figure the phone could not have produced from 2,500 - 1,000: it reads, never computes.
    await answer('success', { orderId: 'ord-cash-1', status: 'DELIVERED', claim: null, cash: { due: 2500, collected: 1000, shortfall: 1499, heldForReview: true } });
    expect(fx.toast.show).toHaveBeenCalledWith('Recorded short — held for review', 'Handed over for $1,000 of $2,500 due ($1,499 short). Swift deducted nothing; operations will review it.');
  });
});

describe('customer can’t pay at all', () => {
  it('0 taken: short_payment with collectedAmount 0 and no cash-returned question', async () => {
    await render(cashDoorJob());
    await click(buttonNamed("Customer can't pay in full"));
    await type('0');
    expect(buttonNamed('I gave it back')).toBeNull();
    await click(byTestId('door-cash-review'));
    expect(dialog()?.textContent).toContain('Keep the order: it goes back to the store.');
    await click(byTestId('door-cash-confirm'));
    expect(fx.riderAct.mutate.mock.calls[0]![0]).toEqual({
      id: 'ord-cash-1', action: 'handover', outcome: 'short_payment', collectedAmount: 0, handoverVersion: 'door-v1',
    });
    await answer('success', { orderId: 'ord-cash-1', status: 'RETURNING', claim: null });
    expect(fx.toast.success).toHaveBeenCalledWith('Recorded: going back to the store', 'No cash was taken. Take the order back to the store.');
  });
});

describe('the door code boxes read as refused only for a refusal of the code', () => {
  it('a cash-amount refusal leaves them alone; a wrong code marks them', async () => {
    fx.riderAct.isError = true;
    fx.riderAct.error = refusal('CASH_OVER_DUE', 'over');
    await render(cashDoorJob());
    expect(byTestId('door-code')?.getAttribute('data-error')).toBe('false');
    fx.riderAct.error = refusal('INVALID_PIN', 'wrong');
    await render(cashDoorJob());
    expect(byTestId('door-code')?.getAttribute('data-error')).toBe('true');
  });
});

describe('a goods order going back to the store', () => {
  it('shows no door, and reads back the partial cash the server recorded as still held', async () => {
    await render(cashDoorJob({ status: 'RETURNING', doorCashReturnStatus: 'HELD', doorCashReturnAmount: '1000' }));
    expect(text()).toContain("This order is going back to the store. Don't hand it over to the customer.");
    expect(byTestId('door-cash-return-record')?.textContent).toBe("Recorded: you still hold the cashYou still hold $1,000 of the customer's cash. Operations will follow up with you to return it. Take the order back to the store.");
    expect(buttonNamed('Record cash & hand over')).toBeNull();
    expect(buttonNamed("Customer didn't pay")).toBeNull();
    expect(byTestId('custody-recovery')).toBeTruthy();
  });

  it('cash operations settled reads as settled; no recorded cash reads as nothing', async () => {
    await render(cashDoorJob({ status: 'RETURNING', doorCashReturnStatus: 'RESOLVED', doorCashReturnAmount: '1000' }));
    expect(byTestId('door-cash-return-record')?.textContent).toBe("Settled by operationsOperations recorded the customer's $1,000 as settled.");
    await render(cashDoorJob({ status: 'RETURNING', doorCashReturnStatus: null, doorCashReturnAmount: null }));
    expect(byTestId('door-cash-return-record')).toBeNull();
    expect(buttonNamed('Record cash & hand over')).toBeNull();
  });
});
