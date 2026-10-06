import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const hooks = { useMemo: (fn: () => unknown) => fn(), useState: (value: unknown) => [value, vi.fn()], useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn, useEffect: () => {} };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View', RefreshControl: 'RefreshControl' }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {} }));
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
  it('loading failure cannot show a fabricated zero balance', () => {
    const rendered = text(WeeklyFeeScreen({ family: 'rider', error: true, refresh: vi.fn() }));
    expect(rendered).toContain("couldn't load your weekly fee"); expect(rendered).not.toContain('Nothing due');
  });
});
