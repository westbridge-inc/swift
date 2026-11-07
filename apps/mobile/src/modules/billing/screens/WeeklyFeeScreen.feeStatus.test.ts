import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { FeeSubscription } from '../../../lib/weeklyFee';

// [FEE-STATUS · owner 25 Oct 2026, iPhone build 12 on staging] The store's Weekly fee
// screen read "Nothing due right now: your next bill is 13 Oct 2026" + "Active" on
// 25 October, and "the Refresh status button never worked": it re-read the fee but
// showed nothing while it did, and nothing after. The header now leads with the
// API's feeStatus, and Refresh status says it is checking, then when it last checked.

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

type Props = { children?: unknown; label?: string; loading?: boolean; onPress?: () => unknown; testID?: string };
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
function render(sub: FeeSubscription) {
  host.index = 0;
  const tree = WeeklyFeeScreen({ family: 'vendor', sub, refresh });
  for (const run of host.effects.splice(0)) run();
  return tree;
}
const refreshButton = (tree: unknown) => all(tree).find((p) => p.label === 'Refresh status')!;

// The owner's store at 16:52Z (STAGING-RUN read-only, 25 Oct): ACTIVE, due 14 Oct 00:26Z, two weeks' money received.
const ownerRow: FeeSubscription = { status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-14T00:26:00Z', currentPeriodEnd: '2026-10-14T00:26:00Z', payActions: [{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }] };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T16:52:00Z')); host.slots = []; host.index = 0; host.effects = []; refresh = vi.fn(); });
afterEach(() => { for (const slot of host.slots) slot.cleanup?.(); vi.useRealTimers(); });

describe('Weekly fee header [FEE-STATUS]', () => {
  it("the owner's store never reads as a next bill or Active on a date that has passed (an API before feeStatus)", () => {
    const shown = text(render(ownerRow));
    expect(shown).not.toMatch(/next bill|Nothing due right now|active until/i);
    expect(shown).not.toMatch(/\bActive\b/);
    expect(shown).toContain('Nothing to pay for the week from 13 Oct 2026');
  });

  it("leads with the API's own words when it sends them", () => {
    const shown = text(render({ ...ownerRow, feeStatus: { state: 'COVERED', headline: 'Week from 13 Oct 2026 already paid', detail: 'Swift applies the payment you already made. Nothing more is due for this week.', date: '2026-10-14T00:26:00.000Z' } }));
    expect(shown).toContain('Week from 13 Oct 2026 already paid');
    expect(shown).toContain('Swift applies the payment you already made.');
  });

  it('a week that is due names the day it fell due and the amount', () => {
    const shown = text(render({ ...ownerRow, amountDueGyd: 15000, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 15000, currencyCode: 'GYD' }] }));
    expect(shown).toContain('Payment due since 13 Oct 2026');
    expect(shown).toContain('GY$15,000 to pay.');
    expect(shown).toContain('Pay GY$15,000 with MMG');
  });
});

describe('Refresh status does something you can see [FEE-STATUS]', () => {
  it('re-reads the fee, shows it is checking, then when it last checked', async () => {
    let finish: (_v: unknown) => void = () => {};
    refresh.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const before = refreshButton(render(ownerRow));
    expect(before.loading).toBeFalsy();
    const done = before.onPress!();
    expect(refresh).toHaveBeenCalledOnce();
    expect(refreshButton(render(ownerRow)).loading).toBe(true);
    finish({ isError: false });
    await done; await vi.advanceTimersByTimeAsync(0);
    const after = render(ownerRow);
    expect(refreshButton(after).loading).toBeFalsy();
    expect(text(after)).toContain('Checked at 12:52');
  });

  it('a failed re-read never claims it checked (the query error shows instead)', async () => {
    refresh.mockResolvedValue({ isError: true });
    await refreshButton(render(ownerRow)).onPress!();
    expect(text(render(ownerRow))).not.toContain('Checked at');
    expect(refreshButton(render(ownerRow)).loading).toBeFalsy();
    host.index = 0;
    const failed = all(WeeklyFeeScreen({ family: 'vendor', sub: ownerRow, refresh, error: true })) as Array<{ message?: string }>;
    expect(failed.some((p) => p.message === "We couldn't load your weekly fee. Try again.")).toBe(true);
  });

  it('a second tap while one re-read is running starts no other', async () => {
    refresh.mockImplementation(() => new Promise(() => {}));
    void refreshButton(render(ownerRow)).onPress!();
    void refreshButton(render(ownerRow)).onPress!();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
