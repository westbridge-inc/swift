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
vi.mock('../../../kit', () => Object.fromEntries(['Card', 'ErrorState', 'Header', 'LoadingBlock', 'PillButton', 'Screen', 'T'].map((name) => [name, name])));
vi.mock('../../../services/api', () => ({ weeklyFeeApi: () => ({ start: vi.fn(), read: vi.fn() }) }));
vi.mock('../../../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, useAuthStore: (pick: (s: unknown) => unknown) => pick({ user: { id: 'test-partner' } }) }));
vi.mock('../../../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (s: unknown) => unknown) => pick({ selectedStoreId: 'test-store' }) }));
import { WeeklyFeeScreen } from './WeeklyFeeScreen';
import type { FeeSubscription } from '../../../lib/weeklyFee';
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  const props = (node as ReactElement<{ children?: unknown; label?: string; message?: string }>).props;
  return props ? [props.label, props.message, text(props.children)].filter(Boolean).join(' ') : '';
}
function findByTestId(node: unknown, testID: string): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByTestId(child, testID); if (hit) return hit; }
    return undefined;
  }
  if (node == null || typeof node !== 'object') return undefined;
  const el = node as ReactElement<{ testID?: string; children?: unknown }>;
  if (!el.props) return undefined;
  if (el.props.testID === testID) return el;
  return findByTestId(el.props.children, testID);
}
describe('actual phone weekly fee element tree', () => {
  it.each(['live', 'off', 'absent'] as const)('shows the Pay control only for %s', (state) => {
    const sub = { status: 'ACTIVE', amountDueGyd: 1200, payActions: state === 'absent' ? undefined : [{ id: 'MMG_CHECKOUT', state, amountGyd: 1200, currencyCode: 'GYD' }], san: 'private-number', sanFormatted: 'private-number', payCashSteps: ['MMG agent'], activationCopy: 'instant restore' } as FeeSubscription;
    const rendered = text(WeeklyFeeScreen({ family: 'vendor', sub, refresh: vi.fn() }));
    expect(rendered.includes('Pay GY$1,200 with MMG')).toBe(state === 'live');
    expect(rendered).not.toMatch(/private-number|MMG agent|instant restore|coming soon/i);
    expect(rendered).toContain('100%');
  });
  it("each recent checkout shows the Swift reference, and MMG's transaction ID only once confirmed", () => {
    const base = { amountGyd: 2100, currencyCode: 'GYD' as const, createdAt: '2026-10-01T19:38:19Z', expiresAt: '2026-10-01T20:08:19Z', subscriptionStatus: 'ACTIVE' };
    const sub = { status: 'ACTIVE', amountDueGyd: 0, recentCheckouts: [
      { ...base, ref: 'paid-ref', status: 'CONFIRMED', confirmedAt: '2026-10-01T19:39:42Z', swiftReference: '175933829900012345', mmgTransactionId: '20402048536279' },
      { ...base, ref: 'held-ref', status: 'HELD', confirmedAt: null, swiftReference: '175933840000054321', mmgTransactionId: '20402048599999' },
      { ...base, ref: 'old-ref', status: 'NOT_PAID', confirmedAt: null },
    ] } as FeeSubscription;
    const rendered = text(WeeklyFeeScreen({ family: 'vendor', sub, refresh: vi.fn() }));
    expect(rendered).toContain('Recent checkouts');
    expect(rendered).toMatch(/Swift reference\s*:\s*175933829900012345/);
    expect(rendered).toMatch(/MMG transaction ID\s*:\s*20402048536279/);
    expect(rendered).toMatch(/Swift reference\s*:\s*175933840000054321/);
    expect(rendered).not.toContain('20402048599999');
    expect(rendered.match(/Swift reference/g)).toHaveLength(2);
    expect(rendered.match(/MMG transaction ID/g)).toHaveLength(1);
  });
  it('[NO-DEAD-ENDS] a payment held for checking keeps Pay away and opens a ticket that carries the Swift reference', () => {
    const held = { amountGyd: 2100, currencyCode: 'GYD' as const, createdAt: '2026-10-01T19:38:19Z', expiresAt: '2026-10-01T20:08:19Z', subscriptionStatus: 'PAST_DUE', ref: 'held-ref', status: 'HELD' as const, confirmedAt: null, swiftReference: '175933840000054321' };
    const sub = { status: 'PAST_DUE', amountDueGyd: 2100, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 2100, currencyCode: 'GYD' }], latestMmgCheckout: held, recentCheckouts: [held] } as FeeSubscription;
    const tree = WeeklyFeeScreen({ family: 'vendor', sub, refresh: vi.fn() });
    const rendered = text(tree);
    expect(rendered).not.toContain('Pay GY$2,100 with MMG');
    expect(rendered).toContain("Don't pay again");
    const door = findByTestId(tree, 'weekly-fee-held-help');
    expect(door, 'a held payment offers a way to reach a person').toBeTruthy();
    nav.navigate.mockClear();
    (door!.props as { onPress: () => void }).onPress();
    expect(nav.navigate).toHaveBeenCalledWith('GetHelp', { category: 'PAYMENT', subject: 'My weekly fee payment is being checked', message: 'Swift reference: 175933840000054321' });
  });
  it('control: no held payment, no held-payment door', () => {
    const sub = { status: 'ACTIVE', amountDueGyd: 0 } as FeeSubscription;
    expect(findByTestId(WeeklyFeeScreen({ family: 'vendor', sub, refresh: vi.fn() }), 'weekly-fee-held-help')).toBeUndefined();
  });
  it('loading failure cannot show a fabricated zero balance', () => {
    const rendered = text(WeeklyFeeScreen({ family: 'rider', error: true, refresh: vi.fn() }));
    expect(rendered).toContain("couldn't load your weekly fee"); expect(rendered).not.toContain('Nothing due');
  });
});
