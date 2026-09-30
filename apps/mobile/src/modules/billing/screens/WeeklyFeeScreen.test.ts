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
  it('loading failure cannot show a fabricated zero balance', () => {
    const rendered = text(WeeklyFeeScreen({ family: 'rider', error: true, refresh: vi.fn() }));
    expect(rendered).toContain("couldn't load your weekly fee"); expect(rendered).not.toContain('Nothing due');
  });
});
