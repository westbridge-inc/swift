import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { CheckoutStatus, FeeSubscription } from '../../../lib/weeklyFee';

// A small hook host lets the native element tree retain state and run effect
// dependencies without a simulator. The session and screen are real code.
const host = vi.hoisted(() => ({
  index: 0, slots: [] as Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
  start: vi.fn(), reopen: vi.fn(), open: vi.fn(), keys: 0, read: vi.fn(), active: undefined as undefined | ((_state: string) => void),
  pending: false, recovery: null as null | { retry: () => void; cancel: () => void },
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const next = () => { const i = host.index++; return host.slots[i] ?? (host.slots[i] = {}); };
  const differs = (before?: unknown[], after?: unknown[]) => !before || !after || before.length !== after.length || after.some((v, i) => !Object.is(v, before[i]));
  const memo = (fn: () => unknown, deps?: unknown[]) => { const slot = next(); if (differs(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; } return slot.value; };
  const hooks = {
    useMemo: memo, useCallback: (fn: unknown, deps?: unknown[]) => memo(() => fn, deps),
    useState: (initial: unknown) => { const slot = next(); if (!('value' in slot)) slot.value = initial; return [slot.value, (value: unknown) => { slot.value = value; }]; },
    useRef: (current: unknown) => { const slot = next(); return slot.value ?? (slot.value = { current }); },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const slot = next(); if (differs(slot.deps, deps)) { slot.deps = deps; host.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; }); }
    },
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View', RefreshControl: 'RefreshControl', AppState: { addEventListener: (_event: string, fn: typeof host.active) => { host.active = fn; return { remove: () => { host.active = undefined; } }; } } }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {} }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: host.open }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `tap-key-${++host.keys}` }));
vi.mock('@swift/ui', () => ({ space: {} }));
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'ErrorState', 'Header', 'LoadingBlock', 'PillButton', 'Screen', 'T'].map((name) => [name, name])));
vi.mock('../../../services/api', () => ({ weeklyFeeApi: () => ({ start: host.start, read: host.read, reopen: host.reopen }) }));
vi.mock('../../../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, useAuthStore: (pick: (_s: unknown) => unknown) => pick({ user: { id: 'test-partner' } }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (_s: unknown) => unknown) => pick({ selectedStoreId: 'store-B', feeContextPending: host.pending, feeContextError: host.recovery }) }));
import { WeeklyFeeScreen } from './WeeklyFeeScreen';
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  const props = (node as ReactElement<{ children?: unknown; label?: string }>).props;
  return props ? [props.label, text(props.children)].filter(Boolean).join(' ') : '';
}
const checkout = (status: CheckoutStatus['status']): CheckoutStatus => ({ ref: 'same-ref', status, amountGyd: 1200, currencyCode: 'GYD', createdAt: '2026-09-29T12:00:00Z', expiresAt: '2026-09-29T13:00:00Z', confirmedAt: status === 'CONFIRMED' ? '2026-09-29T13:01:00Z' : null, subscriptionStatus: 'ACTIVE' });
const refresh = vi.fn();
function render(sub: FeeSubscription) {
  host.index = 0;
  const tree = WeeklyFeeScreen({ family: 'vendor', sub, refresh });
  for (const run of host.effects.splice(0)) run();
  return text(tree);
}
beforeEach(() => { vi.useFakeTimers(); host.slots = []; host.index = 0; host.effects = []; host.pending = false; host.recovery = null; host.read.mockReset().mockResolvedValue(checkout('EXPIRED')); refresh.mockReset(); });
afterEach(() => { for (const slot of host.slots) slot.cleanup?.(); vi.useRealTimers(); });
describe('phone checkout lifecycle', () => {
  it('shows late CONFIRMED from a refreshed subscription with the SAME ref', async () => {
    let sub: FeeSubscription = { status: 'ACTIVE', latestMmgCheckout: checkout('EXPIRED'), recentCheckouts: [checkout('EXPIRED')] };
    render(sub); await vi.advanceTimersByTimeAsync(0);
    expect(render(sub)).toContain('This checkout expired');
    sub = { ...sub, latestMmgCheckout: checkout('CONFIRMED'), recentCheckouts: [checkout('CONFIRMED')] };
    render(sub);
    const rendered = render(sub);
    expect(rendered).toContain('Paid: GY$1,200'); expect(rendered).not.toContain('This checkout expired');
  });
  it('refreshes on AppState active even after polling has stopped', async () => {
    const sub: FeeSubscription = { status: 'ACTIVE', latestMmgCheckout: checkout('EXPIRED') };
    render(sub); await vi.advanceTimersByTimeAsync(700_000);
    const before = host.read.mock.calls.length;
    host.read.mockResolvedValue(checkout('CONFIRMED'));
    host.active!('active'); await vi.advanceTimersByTimeAsync(0);
    expect(host.read.mock.calls.length).toBeGreaterThan(before);
    expect(refresh).toHaveBeenCalled(); expect(render(sub)).toContain('Paid: GY$1,200');
  });
  it('keeps Pay unavailable while a notification store is unresolved', () => {
    host.pending = true;
    expect(render({ status: 'ACTIVE', payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] })).not.toContain('Pay GY$1,200 with MMG');
  });
  it('renders actionable Retry and Cancel while the notification remains unresolved', () => {
    host.pending = true;
    host.recovery = { retry: vi.fn(), cancel: vi.fn() };
    host.index = 0;
    const tree = WeeklyFeeScreen({ family: 'vendor', sub: { status: 'ACTIVE', payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] }, refresh });
    expect(text(tree)).toContain("Couldn't open the notified store's weekly fee.");
    expect(text(tree)).not.toContain('Pay GY$');
    const buttons = (node: unknown): Array<{ label?: string; onPress?: () => void }> => {
      if (Array.isArray(node)) return node.flatMap(buttons);
      if (!node || typeof node !== 'object' || !('props' in node)) return [];
      const props = (node as ReactElement<{ label?: string; onPress?: () => void; children?: unknown }>).props;
      return [props, ...buttons(props.children)];
    };
    buttons(tree).find((p) => p.label === 'Retry')!.onPress!();
    buttons(tree).find((p) => p.label === 'Cancel')!.onPress!();
    expect(host.recovery.retry).toHaveBeenCalledOnce();
    expect(host.recovery.cancel).toHaveBeenCalledOnce();
  });

});


describe('relaunch with the server’s own reopen signal', () => {
  const open = () => ({ ...checkout('OPEN'), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  const buttons = (node: unknown): Array<{ label?: string; onPress?: () => void }> => {
    if (Array.isArray(node)) return node.flatMap(buttons);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const props = (node as ReactElement<{ label?: string; onPress?: () => void; children?: unknown }>).props;
    return [props, ...buttons(props.children)];
  };
  it('a killed app relaunch shows Back, its Guyana deadline, and each tap asks for the same page with a new key', async () => {
    vi.setSystemTime(new Date('2026-10-08T23:00:00Z'));
    const c = open();
    const sub = { status: 'ACTIVE', latestMmgCheckout: c, reopenableMmgCheckout: { ref: c.ref, expiresAt: c.expiresAt }, payActions: [{ id: 'MMG_CHECKOUT' as const, state: 'off' as const }] };
    host.keys = 0; host.read.mockResolvedValue(c);
    host.start.mockReset(); host.reopen.mockReset().mockResolvedValue({ ...c, checkoutUrl: 'https://checkout.test/same-page' }); host.open.mockReset().mockResolvedValue({ type: 'cancel' });
    render(sub); await vi.advanceTimersByTimeAsync(0);
    expect(render(sub)).toContain("Back to MMG's page"); expect(render(sub)).toContain('Swift keeps this checkout open until 19:30 (Guyana time).');
    expect(render(sub)).toContain("Already paid on MMG's page? Don't pay again — we'll confirm it with MMG.");
    for (let i = 0; i < 2; i++) {
      host.index = 0; const tree = WeeklyFeeScreen({ family: 'vendor', sub, refresh });
      buttons(tree).find((p) => p.label === "Back to MMG's page")!.onPress!();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(host.reopen.mock.calls).toEqual([[c.ref, 'tap-key-1'], [c.ref, 'tap-key-2']]);
    expect(host.start).not.toHaveBeenCalled();
    expect(host.open.mock.calls.map(([url]) => url)).toEqual(['https://checkout.test/same-page', 'https://checkout.test/same-page']);
    const expired = { ...sub, latestMmgCheckout: { ...c, status: 'EXPIRED' as const }, reopenableMmgCheckout: null };
    render(expired); expect(render(expired)).toContain('Swift support will check this payment.');
    expect(render(expired)).not.toMatch(/Back to MMG|Pay GY|Retry/);
  });
  it('the deadline itself removes Back and shows support copy even if the server read remains OPEN', async () => {
    vi.setSystemTime(new Date('2026-10-08T23:00:00Z'));
    const c = open(); const sub = { status: 'ACTIVE', latestMmgCheckout: c, reopenableMmgCheckout: { ref: c.ref, expiresAt: c.expiresAt } };
    host.read.mockResolvedValue(c); render(sub); await vi.advanceTimersByTimeAsync(0);
    expect(render(sub)).toContain("Back to MMG's page");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(render(sub)).not.toContain("Back to MMG's page");
    expect(render(sub)).toContain('Swift support will check this payment.');
    expect(refresh).toHaveBeenCalled();
  });
  it('OPEN alone never grants reopen and an unresolved store hides the affordance', () => {
    const c = open(); const sub = { status: 'ACTIVE', latestMmgCheckout: c };
    expect(render(sub)).not.toContain("Back to MMG's page");
    host.pending = true;
    expect(render({ ...sub, reopenableMmgCheckout: { ref: c.ref, expiresAt: c.expiresAt } })).not.toContain("Back to MMG's page");
  });
});


describe('[review F1] a stale Back tap on the phone', () => {
  const tapBack = (sub: FeeSubscription) => {
    host.index = 0; const tree = WeeklyFeeScreen({ family: 'vendor', sub, refresh });
    const find = (node: unknown): Array<{ label?: string; onPress?: () => void }> => {
      if (Array.isArray(node)) return node.flatMap(find);
      if (!node || typeof node !== 'object' || !('props' in node)) return [];
      const props = (node as ReactElement<{ label?: string; onPress?: () => void; children?: unknown }>).props;
      return [props, ...find(props.children)];
    };
    find(tree).find((p) => p.label === "Back to MMG's page")!.onPress!();
  };
  it.each([
    ['the server refuses it (the checkout was paid elsewhere)', () => host.reopen.mockReset().mockRejectedValue({ response: { status: 409, data: { error: { code: 'CHECKOUT_NOT_REOPENABLE', details: { ref: 'same-ref', status: 'CONFIRMED' } } } } })],
    ['the server answers with another checkout', () => host.reopen.mockReset().mockResolvedValue({ ref: 'another-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/other-page', amountGyd: 1200, currencyCode: 'GYD', expiresAt: '2099-01-01T00:00:00Z' })],
  ])('opens no MMG page when %s, and refreshes', async (_case, arrange) => {
    vi.setSystemTime(new Date('2026-10-08T23:00:00Z'));
    const c = { ...checkout('OPEN'), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    const sub = { status: 'ACTIVE', latestMmgCheckout: c, reopenableMmgCheckout: { ref: c.ref, expiresAt: c.expiresAt } };
    host.read.mockResolvedValue(c); host.start.mockReset(); host.open.mockReset(); arrange();
    render(sub); await vi.advanceTimersByTimeAsync(0);
    tapBack(sub); await vi.advanceTimersByTimeAsync(0);
    expect(host.reopen).toHaveBeenCalledOnce();
    expect(host.start).not.toHaveBeenCalled(); expect(host.open).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect(host.read).not.toHaveBeenCalledWith('another-ref');
  });
});
