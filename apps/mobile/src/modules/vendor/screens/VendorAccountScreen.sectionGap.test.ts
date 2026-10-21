import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// [OWNER 21 Oct, build 11/12 on iPhone] Swift Business -> Account: the "Stop
// weekly billing" button sat FLUSH on the "Your MMG number" card under it.
// This screen stacks its sections with marginBottom: space.lg; the button
// brought the driver screen's marginTop and nothing below. This renders the
// owner's Account screen (every owner/manager section on, real section
// components where they own their spacing) and measures the space between
// EVERY pair of consecutive blocks: cards, notices and full-width buttons.

const state = vi.hoisted(() => ({ sub: { status: 'ACTIVE', weeklyRate: 2000, autoRenew: true, currentPeriodEnd: '2026-10-28T12:00:00Z' } as Record<string, unknown> }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useState = (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined];
  const useEffect = () => undefined;
  const useMemo = (fn: () => unknown) => fn();
  const useCallback = (fn: unknown) => fn;
  const useRef = (v: unknown) => ({ current: v });
  const hooks = { useState, useEffect, useMemo, useCallback, useRef };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View', Pressable: 'Pressable', TextInput: 'TextInput', StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 }, Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default } }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../../../kit', () => new Proxy({ useLogoutConfirm: () => ({ requestLogout: vi.fn(), logoutDialog: null }) } as Record<string, unknown>, {
  get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key)),
  has: () => true,
}));
vi.mock('../../../kit/controls', () => ({ BrandSwitch: 'BrandSwitch' }));
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../services/api', () => ({ vendorApi: {} }));
vi.mock('../../../hooks/useVendorMutation', () => ({ guardVendorOperation: (fn: unknown) => fn, useVendorMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/verification', () => ({ useVerificationStatus: () => ({ data: { roleVerified: true }, isLoading: false, isError: false, refetch: vi.fn() }) }));
vi.mock('../../../hooks/vendorops', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false, isSuccess: false });
  return {
  useVendorProfile: () => ({ owner: { myRole: 'OWNER' }, store: { id: 'store-1', name: 'Test store', vendorType: 'RESTAURANT', city: 'Georgetown', phone: '+5920000000', mmgNumber: '6000000', latitude: 6.8, longitude: -58.16 } }),
  useVendorQr: () => ({ data: { status: 'ACTIVE', shortUrl: 'https://example.test/s/x' } }),
  useVendorStaff: () => ({ data: [] }),
  useAddStaff: mutation, useRemoveStaff: mutation, useUpdateStaffRole: mutation,
  useVendorPromos: () => ({ data: [] }),
  useCreatePromo: mutation, useUpdatePromo: mutation, useDeletePromo: mutation,
  useVendorSubscription: () => ({ data: state.sub }),
  useSetVendorBillingMethod: mutation,
  useVendorHours: () => ({ data: [], isSuccess: true, isLoading: false, isError: false }),
  useSetHours: mutation,
  };
});
vi.mock('../../../components/onboarding/DocumentChecklist', () => ({ DocumentChecklist: 'DocumentChecklist' }));
vi.mock('../../../components/JobAlertSettingsRow', () => ({ JobAlertSettingsRow: 'JobAlertSettingsRow' }));
vi.mock('../../../components/WithdrawStaffInvites', () => ({ WithdrawStaffInvites: 'WithdrawStaffInvites' }));
vi.mock('../../../components/StoreLocationPicker', () => ({ StoreLocationPicker: 'StoreLocationPicker' }));
vi.mock('../../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: 'RoleSwitcherSheet' }));
vi.mock('../../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn }) }));
vi.mock('../../../lib/stepUp', () => ({ isStepUpDismissed: () => false, serverMessage: () => '', fmtWhen: () => null }));
vi.mock('../../../lib/images', () => ({ mediaUrl: (u: string) => u }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: (pick: (s: unknown) => unknown) => pick({ isAuthenticated: true, setIntent: vi.fn() }) }));
vi.mock('../../../stores/vendorPreview', () => ({ useVendorPreview: (pick: (s: unknown) => unknown) => pick({ previewType: null, exitPreview: vi.fn() }) }));

import { space } from '@swift/ui';
import { VendorAccountScreen } from './VendorAccountScreen';

type El = React.ReactElement<Record<string, any>>;
const flat = (style: unknown): Record<string, number> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : ((style as Record<string, number>) ?? {});
const kids = (el: El): El[] => {
  const c = el.props['children'];
  return React.Children.toArray(typeof c === 'function' ? c({ pressed: false }) : c).filter((k): k is El => React.isValidElement(k));
};
/** Call function components until a host element or a fragment is reached. */
function resolve(el: El): El | null {
  let cur: El | null = el;
  for (let i = 0; i < 12 && cur && typeof cur.type === 'function'; i++) cur = (cur.type as (p: unknown) => El | null)(cur.props);
  return cur;
}
/** The blocks a stack lays out, top to bottom: fragments and components unwrapped. */
function blocks(children: El[]): El[] {
  return children.flatMap((child) => {
    const h = resolve(child);
    if (!h) return [];
    if (h.type === React.Fragment) return blocks(kids(h));
    if (typeof h.type === 'string' && /^(PopupCard|RoleSwitcherSheet|StoreLocationPicker)$/.test(h.type)) return [];
    return [h];
  });
}
/** The space a block keeps above / below itself (a one-child wrapper adds its child's). */
function edge(h: El, side: 'marginTop' | 'marginBottom'): number {
  const own = flat(h.props['style'])[side] ?? 0;
  const inner = (h.type === 'View' || h.type === 'Pressable') ? blocks(kids(h)) : [];
  return own + (inner.length === 1 ? edge(inner[0]!, side) : 0);
}
const label = (h: El): string => {
  const t = JSON.stringify(h.props, (k, v) => (k === '_owner' || k === '_store' || typeof v === 'function' ? undefined : v)) ?? '';
  if (t.includes('Stop weekly billing')) return 'Stop weekly billing';
  if (t.includes('Weekly billing stopped')) return 'Weekly billing stopped';
  if (t.includes('Your MMG number')) return 'Your MMG number';
  return `${String(h.type)}#${t.slice(0, 40)}`;
};

function render() {
  const screen = resolve(React.createElement(VendorAccountScreen) as El)!;
  const find = (el: El): El | null => (el.type === 'ScrollView' ? el : kids(el).map(find).find(Boolean) ?? null);
  const list = blocks(kids(find(screen)!));
  const gaps = list.slice(1).map((b, i) => ({ pair: `${label(list[i]!)} -> ${label(b)}`, gap: edge(list[i]!, 'marginBottom') + edge(b, 'marginTop') }));
  const heading = (h: El) => h.type === 'T' && h.props['variant'] === 'heading';
  // A section heading sits space.md above its own card; every other pair is a section gap.
  const want = list.slice(1).map((_b, i) => (heading(list[i]!) ? space.md : space.lg));
  return { list, gaps, names: list.map(label), want };
}

describe('[OWNER 21 Oct] Swift Business Account: every section keeps the section gap', () => {
  it('"Stop weekly billing" sits space.lg above "Your MMG number", never flush', () => {
    state.sub = { status: 'ACTIVE', weeklyRate: 2000, autoRenew: true, currentPeriodEnd: '2026-10-28T12:00:00Z' };
    const { gaps, names } = render();
    const i = names.indexOf('Stop weekly billing');
    expect(i, names.join(' | ')).toBeGreaterThan(0);
    expect(names[i + 1]).toBe('Your MMG number');
    expect(gaps[i]!.gap, gaps[i]!.pair).toBe(space.lg);
    expect(gaps[i - 1]!.gap, gaps[i - 1]!.pair).toBe(space.lg);
  });

  it('the stopped panel keeps the same gap', () => {
    state.sub = { status: 'ACTIVE', weeklyRate: 2000, autoRenew: false, currentPeriodEnd: '2026-10-28T12:00:00Z' };
    const { gaps, names } = render();
    const i = names.indexOf('Weekly billing stopped');
    expect(i, names.join(' | ')).toBeGreaterThan(0);
    expect(gaps[i]!.gap, gaps[i]!.pair).toBe(space.lg);
  });

  it('no two blocks on the screen touch, and none is doubled', () => {
    state.sub = { status: 'ACTIVE', weeklyRate: 2000, autoRenew: true, currentPeriodEnd: '2026-10-28T12:00:00Z' };
    const { gaps, list, want } = render();
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(gaps.filter((g, i) => g.gap !== want[i]).map((g) => `${g.pair}: ${g.gap}`)).toEqual([]);
  });
});
