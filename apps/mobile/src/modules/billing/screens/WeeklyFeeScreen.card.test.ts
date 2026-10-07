import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { FeeSubscription } from '../../../lib/weeklyFee';

// The one weekly-fee page, card half (CARD-CHECKOUT-API). A small hook host keeps
// state and runs effects without a simulator, and child components are rendered,
// so the card section, its session and the MMG half are the real code.
const host = vi.hoisted(() => ({
  index: 0, slots: [] as Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
  open: undefined as unknown as import('vitest').Mock<(..._args: any[]) => any>,
  cardStart: undefined as unknown as import('vitest').Mock<(..._args: any[]) => any>,
  cardRead: undefined as unknown as import('vitest').Mock<(..._args: any[]) => any>,
  cardRemove: undefined as unknown as import('vitest').Mock<(..._args: any[]) => any>,
  mmgStart: undefined as unknown as import('vitest').Mock<(..._args: any[]) => any>,
  mmgRead: undefined as unknown as import('vitest').Mock<(..._args: any[]) => any>,
  keys: 0,
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const next = () => { const i = host.index++; return host.slots[i] ?? (host.slots[i] = {}); };
  const differs = (before?: unknown[], after?: unknown[]) => !before || !after || before.length !== after.length || after.some((v, i) => !Object.is(v, before[i]));
  const memo = (fn: () => unknown, deps?: unknown[]) => { const slot = next(); if (differs(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; } return slot.value; };
  const hooks = {
    useMemo: memo, useCallback: (fn: unknown, deps?: unknown[]) => memo(() => fn, deps),
    useState: (initial: unknown) => { const slot = next(); if (!('value' in slot)) slot.value = initial; return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? (value as (_v: unknown) => unknown)(slot.value) : value; }]; },
    useRef: (current: unknown) => { const slot = next(); return slot.value ?? (slot.value = { current }); },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const slot = next(); if (differs(slot.deps, deps)) { slot.deps = deps; host.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; }); }
    },
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View', RefreshControl: 'RefreshControl', AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {} }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: (...args: unknown[]) => host.open(...args) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `tap-key-${++host.keys}` }));
vi.mock('@swift/ui', () => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return { space: token, color: token, radius: token };
});
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'ConfirmDialog', 'ErrorState', 'Header', 'IconChip', 'LoadingBlock', 'PillButton', 'Screen', 'StatePill', 'T'].map((name) => [name, name])));
vi.mock('../../../services/api', () => ({
  weeklyFeeApi: () => ({ start: host.mmgStart, read: host.mmgRead }),
  cardFeeApi: () => ({ start: host.cardStart, read: host.cardRead, remove: host.cardRemove }),
}));
vi.mock('../../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null, active: false }) }));
vi.mock('../../../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, useAuthStore: (pick: (_s: unknown) => unknown) => pick({ user: { id: 'test-partner' }, sessionGeneration: 1 }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (_s: unknown) => unknown) => pick({ selectedStoreId: 'test-store', feeContextPending: false, feeContextError: null }) }));
import { WeeklyFeeScreen } from './WeeklyFeeScreen';

type Props = { children?: unknown; label?: string; message?: string; accessibilityLabel?: string; onPress?: () => void; testID?: string; [k: string]: unknown };
type Node = ReactElement<Props>;
/** Renders function components too, so the card section's own hooks and words run. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object' || !('props' in node)) return node;
  const element = node as Node;
  if (typeof element.type === 'function') return expand((element.type as (_p: Props) => unknown)(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props.children) } };
}
function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Node;
  return [element, ...nodes(element.props.children)];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  const p = (tree as Node).props;
  return p ? [p.label, p.message, p['title'], p['body'], p['confirmLabel'], text(p.children)].filter(Boolean).join(' ') : '';
}
const refresh = vi.fn();
let tree: unknown;
function render(sub: FeeSubscription) {
  host.index = 0;
  tree = expand(WeeklyFeeScreen({ family: 'vendor', sub, refresh }));
  for (const run of host.effects.splice(0)) run();
  return text(tree);
}
/** Renders until effects settle (a child's state reported to the parent shows on the next pass). */
function settle(sub: FeeSubscription) { render(sub); render(sub); return render(sub); }
const button = (label: string) => nodes(tree).find((n) => n.type === 'PillButton' && n.props.label === label)?.props;
const MMG = { id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' } as const;
const VISA = { id: 'card-1', brand: 'VISA', last4: '4242', expMonth: 4, expYear: 2031, status: 'ACTIVE' };
const cardLive = (extra: Record<string, unknown> = {}) => ({ id: 'CARD', state: 'live', payNow: { amount: 1200, currencyCode: 'GYD' }, addCard: false, cardOnFile: null, ...extra });
const sub = (...payActions: unknown[]) => ({ status: 'PAST_DUE', amountDueGyd: 1200, payActions } as unknown as FeeSubscription);
const view = (status: string, extra: Record<string, unknown> = {}) => ({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status, expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', subscriptionStatus: 'PAST_DUE', testMode: false, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  host.slots = []; host.index = 0; host.effects = []; host.keys = 0;
  host.open = vi.fn(async () => ({ type: 'dismiss' }));
  host.cardStart = vi.fn(async (purpose: string) => ({ sessionId: 'card-session-1', purpose, status: 'OPEN', hostedUrl: 'https://card-page.test/opaque', expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', testMode: false }));
  host.cardRead = vi.fn(async () => view('OPEN'));
  host.cardRemove = vi.fn(async () => ({ card: { ...VISA, status: 'REVOKED' }, paymentInProgress: false }));
  host.mmgStart = vi.fn(); host.mmgRead = vi.fn();
  refresh.mockReset();
});
afterEach(() => { for (const slot of host.slots) slot.cleanup?.(); vi.useRealTimers(); });

describe('the card choice follows the server', () => {
  it.each([
    ['off', sub(MMG, { id: 'CARD', state: 'off' })],
    ['absent', sub(MMG)],
    ['no payActions', { status: 'ACTIVE', amountDueGyd: 1200 } as FeeSubscription],
    ['a zero price', sub(MMG, cardLive({ payNow: { amount: 0, currencyCode: 'GYD' } }))],
    ['a malformed currency', sub(MMG, cardLive({ payNow: { amount: 1200, currencyCode: 'gyd' } }))],
    ['an unknown state', sub(MMG, { id: 'CARD', state: 'coming_soon' })],
  ])('is hidden, never teased, when CARD is %s', (_case, s) => {
    const rendered = settle(s);
    expect(rendered).not.toMatch(/card|visa|mastercard|coming soon/i);
    expect(nodes(tree).some((n) => n.props.testID === 'card-pay')).toBe(false);
    expect(host.cardRead).not.toHaveBeenCalled();
  });
  it('is shown beside MMG when CARD is live', () => {
    const rendered = settle(sub(MMG, cardLive()));
    expect(rendered).toContain('Pay by card (Visa / Mastercard)');
    expect(button('Pay GY$1,200 by card')).toBeDefined();
    expect(button('Pay GY$1,200 with MMG')).toBeDefined();
    expect(rendered).toContain("Swift never sees or keeps your card number");
  });
  it('shows a saved card as brand and last 4 only, with Remove; Add card only when the server allows it', () => {
    let rendered = settle(sub(MMG, cardLive({ cardOnFile: VISA })));
    expect(rendered).toContain('Visa •••• 4242');
    expect(rendered).toContain('Expires 04/31');
    expect(nodes(tree).some((n) => n.props.accessibilityLabel === 'Visa ending in 4242')).toBe(true);
    expect(button('Remove card')).toBeDefined();
    expect(rendered).not.toMatch(/use (a|this|a different) card for the weekly fee/i);
    host.slots = [];
    rendered = settle(sub(MMG, cardLive({ addCard: true })));
    expect(button('Use a card for the weekly fee')).toBeDefined();
    button('Use a card for the weekly fee')!.onPress!();
    rendered = render(sub(MMG, cardLive({ addCard: true })));
    expect(rendered).toContain('Charge this card each week?');
    expect(host.cardStart).not.toHaveBeenCalled();
    button('Agree and add a card')!.onPress!();
    expect(host.cardStart).toHaveBeenCalledWith('ENROLL', 'tap-key-1');
  });
  it('a card that is not ACTIVE, or malformed, is never shown as the card on file', () => {
    expect(settle(sub(cardLive({ cardOnFile: { ...VISA, status: 'REVOKED' } })))).not.toContain('4242');
    host.slots = [];
    expect(settle(sub(cardLive({ cardOnFile: { ...VISA, last4: '42424242' } })))).not.toContain('4242');
  });
  it('has no card-number field of any kind in Swift’s own views', () => {
    settle(sub(MMG, cardLive({ cardOnFile: VISA, addCard: true })));
    expect(nodes(tree).some((n) => n.props.testID === 'card-pay')).toBe(true);
    button('Change card')!.onPress!();
    render(sub(MMG, cardLive({ cardOnFile: VISA, addCard: true })));
    for (const n of nodes(tree)) {
      expect(['TextInput', 'LabeledInput', 'Input', 'CodeInput', 'WebView']).not.toContain(n.type);
      for (const prop of ['keyboardType', 'secureTextEntry', 'textContentType', 'autoComplete', 'onChangeText', 'source']) expect(n.props).not.toHaveProperty(prop);
    }
  });
});

describe('the processor is never named', () => {
  it.each([
    ['live', cardLive({ cardOnFile: { ...VISA, brand: 'POWERTRANZ' }, addCard: true })],
    ['test mode', cardLive({ testMode: true, testModeLabel: 'TEST PAGE' })],
  ])('in the rendered page (%s)', (_case, action) => {
    const rendered = settle(sub(MMG, action));
    expect(JSON.stringify(nodes(tree).map((n) => n.props), (k, v) => (k === 'children' ? undefined : v))).not.toMatch(/power\s*-?\s*tranz/i);
    expect(rendered).not.toMatch(/power\s*-?\s*tranz/i);
  });
  it('in an error, even when the server says it', async () => {
    host.cardStart.mockRejectedValueOnce({ response: { status: 502, data: { error: { code: 'CARD_SESSION_UNAVAILABLE', message: 'PowerTranz said no' } } } });
    const s = sub(MMG, cardLive());
    settle(s);
    await button('Pay GY$1,200 by card')!.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    const rendered = settle(s);
    expect(rendered).toContain("The card page couldn't open. Try again in a moment.");
    expect(rendered).not.toMatch(/power\s*-?\s*tranz/i);
  });
  it.each(['OPEN', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'HELD'])('in the %s words, whatever brand the server sends', async (status) => {
    host.cardRead.mockResolvedValue(view(status, { purpose: 'ENROLL', card: { ...VISA, brand: 'PowerTranz' } }));
    const s = sub(MMG, cardLive({ addCard: true }));
    settle(s);
    button('Use a card for the weekly fee')!.onPress!();
    render(s);
    await button('Agree and add a card')!.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    const rendered = settle(s);
    expect(host.cardRead).toHaveBeenCalled();
    expect(rendered).not.toMatch(/power\s*-?\s*tranz/i);
  });
});

describe('card states come from the server only', () => {
  async function pay(s: FeeSubscription) {
    settle(s);
    await button('Pay GY$1,200 by card')!.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    return settle(s);
  }
  it('opens the hosted page in the in-app sheet with the card return, then follows the session', async () => {
    const s = sub(MMG, cardLive());
    const rendered = await pay(s);
    expect(host.cardStart).toHaveBeenCalledExactlyOnceWith('PAY_NOW', 'tap-key-1');
    expect(host.open).toHaveBeenCalledExactlyOnceWith('https://card-page.test/opaque', 'swift://pay/card/return');
    expect(host.cardRead).toHaveBeenCalledWith('card-session-1');
    // The sheet closed (dismissed): the bank has not answered, so nothing is paid and nothing more is offered.
    expect(rendered).toContain('Checking with the bank…');
    expect(rendered).not.toMatch(/paid/i);
    expect(button('Pay GY$1,200 with MMG')).toBeUndefined();
    expect(button('Pay GY$1,200 by card')).toBeUndefined();
    expect(button('Continue on the card page')).toBeDefined();
  });
  it('UNKNOWN says do not pay again; only SUCCEEDED says paid', async () => {
    const s = sub(MMG, cardLive());
    host.cardRead.mockResolvedValue(view('UNKNOWN'));
    let rendered = await pay(s);
    expect(rendered).toContain("Checking with the bank. Don't pay again.");
    expect(rendered).not.toMatch(/paid/i);
    expect(button('Pay GY$1,200 with MMG')).toBeUndefined();
    host.cardRead.mockResolvedValue(view('SUCCEEDED', { settlement: 'advanced' }));
    await vi.advanceTimersByTimeAsync(3_000);
    rendered = settle(s);
    expect(rendered).toContain('Paid: GY$1,200 received.');
    expect(refresh).toHaveBeenCalled();
    const reads = host.cardRead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.cardRead.mock.calls.length).toBe(reads);
  });
  it('a decline says so plainly and offers the choices again', async () => {
    const s = sub(MMG, cardLive());
    host.cardRead.mockResolvedValue(view('FAILED'));
    const rendered = await pay(s);
    expect(rendered).toContain("The payment didn't go through: the bank declined it, or the card has expired. You can try again.");
    expect(button('Pay GY$1,200 by card')).toBeDefined();
    expect(button('Pay GY$1,200 with MMG')).toBeDefined();
  });
  it('a held payment hides every pay button', async () => {
    const s = sub(MMG, cardLive());
    host.cardRead.mockResolvedValue(view('HELD'));
    const rendered = await pay(s);
    expect(rendered).toContain("We're checking this payment by hand. Don't pay again. Support will contact you.");
    expect(button('Pay GY$1,200 with MMG')).toBeUndefined();
    expect(button('Pay GY$1,200 by card')).toBeUndefined();
  });
  it('a test server labels every card screen', async () => {
    host.cardStart.mockResolvedValue({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status: 'OPEN', hostedUrl: 'https://card-page.test/opaque', expiresAt: '2099-01-01T00:15:00Z', testMode: true, testModeLabel: 'TEST PAGE: no real money' });
    host.cardRead.mockResolvedValue(view('OPEN', { testMode: true, testModeLabel: 'TEST PAGE: no real money' }));
    expect(await pay(sub(cardLive()))).toContain('TEST PAGE: no real money');
  });
  it('a card is not offered while an MMG payment is being confirmed', () => {
    const confirming = { ref: 'mmg-ref', status: 'CONFIRMING', amountGyd: 1200, currencyCode: 'GYD', createdAt: '2026-10-06T12:00:00Z', expiresAt: '2026-10-06T12:30:00Z', confirmedAt: null, subscriptionStatus: 'PAST_DUE' } as const;
    host.mmgRead.mockResolvedValue(confirming);
    const rendered = settle({ ...sub(MMG, cardLive()), latestMmgCheckout: confirming });
    expect(rendered).toContain("Confirming your payment with MMG. Don't pay again.");
    expect(button('Pay GY$1,200 by card')).toBeUndefined();
  });
  it('removing the card asks first, then calls the server and refreshes', async () => {
    const s = sub(MMG, cardLive({ cardOnFile: VISA }));
    settle(s);
    button('Remove card')!.onPress!();
    settle(s);
    const dialog = nodes(tree).find((n) => n.type === 'ConfirmDialog')!;
    expect(dialog.props['open']).toBe(true);
    expect(String(dialog.props['body'])).toContain('Visa •••• 4242 will not be charged again');
    expect(host.cardRemove).not.toHaveBeenCalled();
    await (dialog.props['onConfirm'] as () => Promise<void>)();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.cardRemove).toHaveBeenCalledExactlyOnceWith('card-1');
    expect(refresh).toHaveBeenCalled();
    expect(settle(s)).toContain('Card removed. Nothing more will be charged to it.');
  });
});
