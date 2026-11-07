import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import type { FeeSubscription } from '../../../lib/weeklyFee';

// [SPEED 30 Oct · owner] A business screen opened again shows its last answer at once (the
// cache keeps it) while Swift's new one is on its way. Money is never shown from memory as
// current: the weekly fee then says it is checking for the latest, and Pay waits for it.

// A small hook host (as in WeeklyFeeScreen.lifecycle.test.ts) keeps state between renders.
const host = vi.hoisted(() => ({ index: 0, slots: [] as Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void> }));
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
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {}, useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'tap-key-one' }));
vi.mock('@swift/ui', () => ({ space: {} }));
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'ErrorState', 'Header', 'LoadingBlock', 'PillButton', 'Screen', 'T'].map((name) => [name, name])));
vi.mock('../../../services/api', () => ({ weeklyFeeApi: () => ({ start: vi.fn(), read: vi.fn(async () => { throw new Error('no checkout'); }) }) }));
vi.mock('../../../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, useAuthStore: (pick: (_s: unknown) => unknown) => pick({ user: { id: 'test-partner' } }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (_s: unknown) => unknown) => pick({ selectedStoreId: 'test-store', feeContextPending: false, feeContextError: null }) }));
import { WeeklyFeeScreen } from './WeeklyFeeScreen';
import { checkingLatest } from '../../../lib/checkingLatest';

type Props = { children?: unknown; label?: string; loading?: boolean; disabled?: boolean; onPress?: () => unknown; testID?: string };
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  const props = (node as ReactElement<Props>).props;
  return props ? [props.label, text(props.children)].filter(Boolean).join(' ') : '';
}
function all(node: unknown): Props[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const props = (node as ReactElement<Props>).props;
  return [props, ...all(props.children)];
}
let refresh = vi.fn();
function render(sub: FeeSubscription, checkingLatest?: boolean) {
  host.index = 0;
  const tree = WeeklyFeeScreen({ family: 'vendor', sub, refresh, checkingLatest });
  for (const run of host.effects.splice(0)) run();
  return tree;
}
const due: FeeSubscription = { status: 'ACTIVE', amountDueGyd: 15000, nextBillingDate: '2026-10-14T00:26:00Z', currentPeriodEnd: '2026-10-14T00:26:00Z', payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 15000, currencyCode: 'GYD' }] };
const pay = (tree: unknown) => all(tree).find((p) => p.label === 'Pay GY$15,000 with MMG')!;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T16:52:00Z')); host.slots = []; host.index = 0; host.effects = []; refresh = vi.fn(); });
afterEach(() => { for (const slot of host.slots) slot.cleanup?.(); vi.useRealTimers(); });

describe('[SPEED 30 Oct] the weekly fee from memory says it is checking, and Pay waits', () => {
  it('opened again while Swift is re-reading: the last status, "Checking for the latest…", Pay held', () => {
    const tree = render(due, true);
    expect(text(tree)).toContain('Payment due since 13 Oct 2026');
    expect(text(tree)).toContain('Checking for the latest…');
    expect(pay(tree).disabled).toBe(true);
  });

  it("once Swift has answered: no checking words, Pay as usual", () => {
    const tree = render(due, false);
    expect(text(tree)).not.toContain('Checking for the latest…');
    expect(pay(tree).disabled).toBe(false);
  });

  it('only an answer from before the screen opened, while a re-read is on its way, counts as checking', () => {
    expect(checkingLatest({ data: { status: 'ACTIVE' }, isFetching: true, dataUpdatedAt: 1_000 }, 2_000)).toBe(true);
    expect(checkingLatest({ data: { status: 'ACTIVE' }, isFetching: false, dataUpdatedAt: 1_000 }, 2_000)).toBe(false);
    expect(checkingLatest({ data: { status: 'ACTIVE' }, isFetching: true, dataUpdatedAt: 3_000 }, 2_000)).toBe(false); // the screen's own poll
    expect(checkingLatest({ data: undefined, isFetching: true, dataUpdatedAt: 0 }, 2_000)).toBe(false); // first load: the spinner
  });

  it.each([
    ['modules/vendor/screens/VendorSwiftNumberScreen.tsx', 'const checkingLatest = useCheckingLatest(q);'],
    ['modules/mover/screens/MoverSwiftNumberScreen.tsx', 'const checkingLatest = useCheckingLatest(q);'],
    ['modules/services/screens/ProviderWeeklyFeeScreen.tsx', 'const checkingLatest = useCheckingLatest(q);'],
  ])('%s tells the screen from its own fee read', (file, line) => {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect(source).toContain(line);
    expect(source).toContain('checkingLatest={checkingLatest}');
  });
});
