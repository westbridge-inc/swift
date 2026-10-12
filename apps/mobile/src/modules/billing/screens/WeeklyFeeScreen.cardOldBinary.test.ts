import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { FeeSubscription } from '../../../lib/weeklyFee';

// [CARD embed] This JavaScript also reaches store builds 9 and 10 (over-the-air updates
// share runtime 1.0.0), which have no react-native-webview. On such a binary the screen
// must load, render and pay exactly as before: the card page opens in the in-app browser
// with the card return, and the in-app card sheet never appears. The real guarded loader
// runs here; only the native side is the old binary's.
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
// A binary built before react-native-webview (store builds 9 and 10): its native side has no
// web view module. Everything else the screen needs is here.
vi.mock('react-native', () => ({
  ScrollView: 'ScrollView', View: 'View', RefreshControl: 'RefreshControl', Modal: 'Modal',
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  TurboModuleRegistry: { get: (name: string) => { host.asked.push(name); return null; } },
}));
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
let WeeklyFeeScreen: typeof import('./WeeklyFeeScreen').WeeklyFeeScreen;
beforeAll(async () => { ({ WeeklyFeeScreen } = await import('./WeeklyFeeScreen')); });

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

describe('a binary without the card web view (store builds 9 and 10)', () => {
  it('the screen module loads without throwing (nothing asks for the web view at import)', async () => {
    host.asked = [];
    await expect(import('./WeeklyFeeScreen')).resolves.toHaveProperty('WeeklyFeeScreen');
    expect(host.asked).not.toContain('RNCWebViewModule');
  });

  it('renders the card choice without throwing, and asks nothing of the native side until a card page opens', () => {
    expect(() => settle(sub(MMG, cardLive()))).not.toThrow();
    expect(button('Pay GY$1,200 by card')).toBeDefined();
    expect(host.asked).not.toContain('RNCWebViewModule');
  });

  it('Pay by card opens the page in the in-app browser with the card return, never the card sheet, then follows the server', async () => {
    const s = sub(MMG, cardLive());
    settle(s);
    await button('Pay GY$1,200 by card')!.onPress!();
    await vi.advanceTimersByTimeAsync(0);
    const rendered = settle(s);
    expect(host.asked).toContain('RNCWebViewModule');
    expect(host.open).toHaveBeenCalledExactlyOnceWith(PAGE, 'swift://pay/card/return');
    expect(nodes(tree).some((n) => n.type === 'Modal' || n.type === 'WebView' || n.props.testID === 'card-page-sheet')).toBe(false);
    expect(host.cardRead).toHaveBeenCalledWith('card-session-1');
    expect(rendered).toContain('Checking with the bank…');
  });
});
