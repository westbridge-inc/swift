import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const fx = vi.hoisted(() => {
  const token: unknown = new Proxy({}, { get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : token });
  return { token, sub: {} as Record<string, unknown> };
});
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const hooks = { useState: (initial: unknown) => [initial, vi.fn()], useEffect: () => {} };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@swift/ui', () => ({ color: fx.token, elevation: fx.token, radius: fx.token, space: fx.token }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('../kit', () => Object.fromEntries(['Card', 'Chip', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'T', 'TonePill'].map((name) => [name, name])));
vi.mock('../kit/switch', () => ({ Switch: 'Switch' }));
vi.mock('../kit/after-dismiss', () => ({ afterDismiss: vi.fn() }));
vi.mock('../services/socket', () => ({ disconnectSocket: vi.fn() }));
vi.mock('../components/onboarding/DocumentUploadCard', () => ({ docLabel: () => '' }));
vi.mock('../hooks/verification', () => ({ useVerificationStatus: () => ({}) }));
vi.mock('../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false }) }));
vi.mock('../stores/authStore', () => ({ useAuthStore: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: (pick: (_s: unknown) => unknown) => pick({}) }));
vi.mock('../hooks/vendorops', () => ({
  useVendorProfile: () => ({ stores: [], owner: { myRole: 'OWNER' } }),
  useVendorSubscription: () => ({ data: fx.sub }),
  ...Object.fromEntries(['useVendorOrderHistory', 'useVendorOrders', 'useToggleOpen', 'useToggleOrders', 'useSetSelfDelivery', 'useOrderAction', 'useVendorMenu', 'useVendorQr', 'useVendorAnalytics', 'useVendorRevenue', 'useVendorOps', 'useVendorHours'].map((name) => [name, () => ({})])),
}));
vi.mock('../modules/vendor/shared', () => ({
  safeVendorRole: (role: string) => role,
  fmtDate: (date: string) => date.slice(0, 10),
  reconciledRevenueDays: () => [], windowTotals: () => ({}), numericFact: () => null,
  TYPES: {}, GUTTER: 0, TabHeader: 'TabHeader', DAY_LABELS: [], catalogueMeta: () => ({}),
  BoardFirstRun: 'BoardFirstRun', BoardFirstRunRow: 'BoardFirstRunRow',
}));
import { VendorOps } from '../modules/vendor/screens/VendorOps';
type Element = ReactElement<{ children?: unknown; accessibilityLabel?: string; label?: string }>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function renderedText(node: unknown): string {
  if (Array.isArray(node)) return node.map(renderedText).join(' ');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  const element = node as Element;
  if (typeof element.type === 'function') return renderedText((element.type as (_props: unknown) => unknown)(element.props));
  const children = typeof element.props.children === 'function' ? element.props.children({ pressed: false }) : element.props.children;
  return [element.props.accessibilityLabel, element.props.label, renderedText(children)].filter(Boolean).join(' ');
}

describe('rendered partner Billing tile census [AX316 R1]', () => {
  it.each(['CASH', 'MOBILE_MONEY'])('%s subscription renders the date/status with no passive payment rail', (billingMethod) => {
    fx.sub = { status: 'ACTIVE', billingMethod, nextBillingDate: '2026-10-06T12:00:00Z' };
    const board = VendorOps({ store: { id: 'store-A', name: 'Test store', status: 'ACTIVE' }, navigation: { navigate: vi.fn() } });
    const grid = elements(board).find((node) => typeof node.type === 'function' && node.type.name === 'VendorManagerManageGrid');
    expect(grid).toBeDefined();
    const tiles = (grid!.type as (_props: unknown) => unknown)(grid!.props);
    const billing = elements(tiles).find((node) => node.props.label === 'Billing');
    expect(billing).toBeDefined();
    const text = renderedText(billing);
    expect(text).toContain('Next bill 2026-10-06');
    expect(text).toContain('ACTIVE');
    expect(text).not.toMatch(/\bcash\b|\bagent\b|Swift[\s-]+Number|account[\s-]+number|coming soon|\bMMG\b/i);
  });
});
