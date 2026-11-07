import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const hooks = { useMemo: (fn: () => unknown) => fn(), useState: (value: unknown) => [value, vi.fn()], useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn, useEffect: () => {} };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View', RefreshControl: 'RefreshControl' }));
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {}, useNavigation: () => nav }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'tap-key-one' }));
vi.mock('@swift/ui', () => ({ space: {} }));
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'ChoiceChip', 'ErrorState', 'Header', 'LoadingBlock', 'PillButton', 'Screen', 'T'].map((name) => [name, name])));
const api = vi.hoisted(() => ({ start: vi.fn(async (_key: string, _weeks?: number) => { throw Object.assign(new Error('not opened in this test'), { response: { status: 503 } }); }) }));
vi.mock('../../../services/api', () => ({ weeklyFeeApi: () => ({ start: api.start, read: vi.fn() }) }));
vi.mock('../../../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, useAuthStore: (pick: (s: unknown) => unknown) => pick({ user: { id: 'test-partner' } }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (s: unknown) => unknown) => pick({ selectedStoreId: 'test-store' }) }));
import { WeeklyFeeScreen } from './WeeklyFeeScreen';
import type { FeeSubscription } from '../../../lib/weeklyFee';

// [owner 6 Nov 2026] Up to four weeks ahead: the phone shows the server's choice of 1-4 weeks (each only when it fits),
// labels Pay with the chosen amount, and sends the chosen weeks. An older API (no weekOptions) pays one week, as before.
function find(node: unknown, hit: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => find(n, hit));
  if (node == null || typeof node !== 'object') return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (!el.props) return [];
  return [...(hit(el) ? [el] : []), ...find(el.props['children'], hit)];
}
const FOUR = [{ weeks: 1, amountGyd: 2100 }, { weeks: 2, amountGyd: 4200 }, { weeks: 3, amountGyd: 6300 }, { weeks: 4, amountGyd: 8400 }];
const subWith = (weekOptions?: typeof FOUR) => ({ status: 'ACTIVE', amountDueGyd: 0, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 2100, currencyCode: 'GYD', ...(weekOptions ? { weekOptions } : {}) }] }) as FeeSubscription;
const payButton = (tree: unknown) => find(tree, (el) => el.type === 'PillButton' && /with MMG$/.test(String(el.props['label'])))[0]!;

describe('[owner 6 Nov] the phone offers 1 to 4 weeks', () => {
  it('shows each choice the server offers, with its amount, says the limit, and pays one week until another is chosen', async () => {
    api.start.mockClear();
    const tree = WeeklyFeeScreen({ family: 'rider', sub: subWith(FOUR), refresh: vi.fn() });
    const chips = find(tree, (el) => el.type === 'ChoiceChip');
    expect(chips.map((c) => c.props['label'])).toEqual(['1 week · GY$2,100', '2 weeks · GY$4,200', '3 weeks · GY$6,300', '4 weeks · GY$8,400']);
    expect(chips.map((c) => c.props['active'])).toEqual([true, false, false, false]);
    expect(find(tree, (el) => el.props['testID'] === 'mmg-weeks')).toHaveLength(1);
    expect(JSON.stringify(find(tree, (el) => el.type === 'T').map((t) => t.props['children']))).toContain('You can pay up to four weeks ahead.');
    expect(payButton(tree).props['label']).toBe('Pay GY$2,100 with MMG');
    (payButton(tree).props['onPress'] as () => void)();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toBe(1);
  });

  it('two weeks fit: two choices; an older API with no choice shows none and sends no weeks', async () => {
    const two = WeeklyFeeScreen({ family: 'vendor', sub: subWith(FOUR.slice(0, 2)), refresh: vi.fn() });
    expect(find(two, (el) => el.type === 'ChoiceChip')).toHaveLength(2);
    api.start.mockClear();
    const old = WeeklyFeeScreen({ family: 'vendor', sub: subWith(), refresh: vi.fn() });
    expect(find(old, (el) => el.type === 'ChoiceChip')).toHaveLength(0);
    expect(find(old, (el) => el.props['testID'] === 'mmg-weeks')).toHaveLength(0);
    expect(payButton(old).props['label']).toBe('Pay GY$2,100 with MMG');
    (payButton(old).props['onPress'] as () => void)();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toBeUndefined();
  });
});
