import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { FeeSubscription } from '../../../lib/weeklyFee';

// [CARD embed] On a binary with the card web view, the bank's card page opens INSIDE Swift
// (CardPageSheet), not in the in-app browser. The sheet decides every navigation, has no
// channel into the page, and closing it — by the return link, by Close, or because the
// server says the page is no longer open — only makes the screen ask the server.
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
  asked: [] as string[],
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
vi.mock('react-native', () => ({
  ScrollView: 'ScrollView', View: 'View', RefreshControl: 'RefreshControl', Modal: 'Modal',
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
// A binary that has the card web view (store build 11 and later): the loader hands back the view.
vi.mock('../../../lib/cardWebView', () => ({ cardWebView: () => 'WebView' }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {}, useNavigation: () => ({ navigate: () => {} }) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: (...args: unknown[]) => host.open(...args) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `tap-key-${++host.keys}` }));
vi.mock('@swift/ui', () => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return { space: token, color: token, radius: token };
});
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'ConfirmDialog', 'ErrorState', 'Header', 'IconChip', 'LoadingBlock', 'PillButton', 'Screen', 'StatePill', 'T'].map((name) => [name, name])));
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.example.test',
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
const PAGE = 'https://api.example.test/api/v1/billing/card/pay/ptz_0123456789abcdef01234567';
const cardLive = () => ({ id: 'CARD', state: 'live', payNow: { amount: 1200, currencyCode: 'GYD' }, addCard: false, cardOnFile: null });
const sub = (...payActions: unknown[]) => ({ status: 'PAST_DUE', amountDueGyd: 1200, payActions } as unknown as FeeSubscription);
const view = (status: string) => ({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status, expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', subscriptionStatus: 'PAST_DUE', testMode: false });

beforeEach(() => {
  vi.useFakeTimers();
  host.slots = []; host.index = 0; host.effects = []; host.keys = 0; host.asked = [];
  host.open = vi.fn(async () => ({ type: 'dismiss' }));
  host.cardStart = vi.fn(async (purpose: string) => ({ sessionId: 'card-session-1', purpose, status: 'OPEN', hostedUrl: PAGE, expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', testMode: false }));
  host.cardRead = vi.fn(async () => view('OPEN'));
  host.cardRemove = vi.fn();
  host.mmgStart = vi.fn(); host.mmgRead = vi.fn();
  refresh.mockReset();
});
afterEach(() => { for (const slot of host.slots) slot.cleanup?.(); vi.useRealTimers(); });

type SheetWebView = {
  source: unknown; originWhitelist: unknown; incognito: unknown; cacheEnabled: unknown; javaScriptCanOpenWindowsAutomatically: unknown;
  onShouldStartLoadWithRequest: (_request: { url: string; isTopFrame?: boolean }) => boolean;
  onLoadStart: (_event: { nativeEvent: { url: string } }) => void;
};
const webView = () => nodes(tree).find((n) => n.type === 'WebView')?.props as unknown as SheetWebView | undefined;
async function openSheet(s: FeeSubscription) {
  settle(s);
  void button('Pay GY$1,200 by card')!.onPress!();
  await vi.advanceTimersByTimeAsync(0);
  return settle(s);
}

describe('the card page inside Swift', () => {
  it('opens the server’s page in the card sheet, not the in-app browser', async () => {
    await openSheet(sub(MMG, cardLive()));
    expect(host.open).not.toHaveBeenCalled();
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(true);
    const props = webView()!;
    expect(props.source).toEqual({ uri: PAGE });
    expect(props.originWhitelist).toEqual(['*']);
    expect(props.incognito).toBe(true);
    expect(props.cacheEnabled).toBe(false);
    expect(props.javaScriptCanOpenWindowsAutomatically).toBe(false);
    for (const channel of ['onMessage', 'injectedJavaScript', 'injectedJavaScriptBeforeContentLoaded', 'injectedJavaScriptObject']) expect(props).not.toHaveProperty(channel);
    // Nothing is decided while the page is open: no read has been answered as paid.
    expect(host.cardRead).not.toHaveBeenCalled();
  });

  it('every navigation is decided by the allow-list: other apps and other sites never load', async () => {
    await openSheet(sub(MMG, cardLive()));
    const decide = webView()!.onShouldStartLoadWithRequest;
    expect(decide({ url: PAGE, isTopFrame: true })).toBe(true);
    expect(decide({ url: 'https://acs.bank.example/challenge', isTopFrame: false })).toBe(true);
    expect(decide({ url: 'https://elsewhere.example/', isTopFrame: true })).toBe(false);
    expect(decide({ url: 'tel:+5920000000' })).toBe(false);
    expect(decide({ url: 'intent://x#Intent;end' })).toBe(false);
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(true);
  });

  it('the return link closes the sheet; the screen then asks the server, and only the server says what happened', async () => {
    const s = sub(MMG, cardLive());
    await openSheet(s);
    expect(webView()!.onShouldStartLoadWithRequest({ url: 'swift://pay/card/return' })).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    const rendered = settle(s);
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(false);
    expect(host.cardRead).toHaveBeenCalledWith('card-session-1');
    expect(rendered).toContain('Checking with the bank…');
    expect(rendered).not.toMatch(/paid/i);
  });

  it('Close closes the sheet the same way', async () => {
    const s = sub(MMG, cardLive());
    await openSheet(s);
    button('Close')!.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    settle(s);
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(false);
    expect(host.cardRead).toHaveBeenCalledWith('card-session-1');
  });

  it('the main frame leaving Swift and the card provider closes the sheet (Android reports frames only here)', async () => {
    const s = sub(MMG, cardLive());
    await openSheet(s);
    webView()!.onLoadStart({ nativeEvent: { url: 'https://elsewhere.example/' } });
    await vi.advanceTimersByTimeAsync(0);
    settle(s);
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(false);
  });

  it('the server saying the page is no longer open closes the sheet; while it is open, the sheet stays', async () => {
    const s = sub(MMG, cardLive());
    await openSheet(s);
    await vi.advanceTimersByTimeAsync(4_000);
    settle(s);
    expect(host.cardRead).toHaveBeenCalledWith('card-session-1');
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(true);
    host.cardRead.mockResolvedValue(view('FAILED'));
    await vi.advanceTimersByTimeAsync(4_000);
    const rendered = settle(s);
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(false);
    expect(rendered).toContain("The payment didn't go through");
  });

  it('a page that is not on this app’s API origin opens in the in-app browser, as before', async () => {
    host.cardStart.mockResolvedValue({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status: 'OPEN', hostedUrl: 'https://card-page.test/opaque', expiresAt: '2099-01-01T00:15:00Z', testMode: false });
    const s = sub(MMG, cardLive());
    settle(s);
    await button('Pay GY$1,200 by card')!.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    settle(s);
    expect(host.open).toHaveBeenCalledExactlyOnceWith('https://card-page.test/opaque', 'swift://pay/card/return');
    expect(nodes(tree).some((n) => n.props.testID === 'card-page-sheet')).toBe(false);
  });
});
