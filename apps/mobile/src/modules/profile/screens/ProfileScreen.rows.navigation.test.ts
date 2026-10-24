/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [UI-SWEEP U-P1, owner 22 Oct] Profile > YOUR ACCOUNT: the "Your rating" row
// was a bare row under five tiled rows: no icon tile, its text starting at the
// left edge instead of the text column, so the list read as broken. One list,
// one row shape: every row in a Profile list is the kit SettingsRow, and a list
// is all tiled or all plain, with one hairline between each pair of rows.
// The REAL ProfileScreen (signed in, and as a guest) on a real React renderer;
// only native drawing, the kit and the reads are stand-ins. The kit row is
// replaced by a marker that records what it was asked to draw.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  signedIn: true,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return { View, ScrollView: View, Pressable: View, StyleSheet: { create: (s: unknown) => s, absoluteFill: {}, hairlineWidth: 1 } };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-reanimated', async () => {
  const R = await import('react');
  const chain: any = { duration: () => chain, delay: () => chain, reduceMotion: () => chain };
  return { default: { View: (p: any) => R.createElement('div', null, p.children) }, FadeInDown: chain, ReduceMotion: {} };
});
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../lib/haptics', () => ({ haptic: { select: vi.fn() } }));
vi.mock('../../../hooks/customer', () => ({
  useProfile: () => ({ data: { firstName: 'Test', lastName: 'Person', createdAt: '2026-01-01T00:00:00Z', customer: { totalOrders: 2 } }, isLoading: false, isError: false, refetch: vi.fn() }),
  useMyRating: () => ({ data: null }),
  useLiveOrders: () => ({ data: { total: 0, items: [] } }),
}));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: () => ({ isAuthenticated: fx.signedIn, promptLogin: vi.fn(), user: { id: 'u-1' }, setIntent: vi.fn() }),
}));
vi.mock('../../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: () => null }));
vi.mock('../../safety/MonitoringControl', () => ({ MonitoringControl: () => null }));
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.example.test',
  customerApi: { getConsent: vi.fn(() => new Promise(() => {})), setMarketingConsent: vi.fn() },
}));
vi.mock('../../../lib/payLink', () => ({ openPayLink: vi.fn() }));
vi.mock('../../../lib/appQueryPolicy', () => ({ retryRead: () => false }));
vi.mock('../../../kit/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));
vi.mock('../../../kit/controls', () => ({ BrandSwitch: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Nothing = () => null;
  const Box = (p: any) => h('div', null, p.children);
  return {
    EmptyState: Nothing, ErrorState: Nothing, IconChip: Nothing, LoadingBlock: Nothing, PillButton: Nothing,
    PopupCard: Nothing, PopupTitle: Nothing, Screen: Box, TrustHalo: Box, Chip: Nothing,
    T: (p: any) => h('span', null, p.children),
    useLogoutConfirm: () => ({ requestLogout: vi.fn(), logoutDialog: null }),
    // The kit row (kit/rows.tsx SettingsRow): `plain` drops its icon tile.
    SettingsRow: (p: any) => h('section', { 'data-row': p.label, 'data-icon': p.icon ?? '', 'data-plain': String(!!p.plain) }),
  };
});

import { ProfileScreen } from './ProfileScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ProfileScreen))));
}

/** Every list on the screen: the element that holds a run of kit rows, with what sits between them. */
function lists(): { rows: HTMLElement[]; between: Element[][] }[] {
  const holders = new Set<Element>();
  for (const row of host.querySelectorAll('section[data-row]')) holders.add(row.parentElement!);
  return [...holders].map((holder) => {
    const kids = [...holder.children];
    const rows = kids.filter((k): k is HTMLElement => k.matches('section[data-row]'));
    const between = rows.slice(1).map((row, i) => kids.slice(kids.indexOf(rows[i]!) + 1, kids.indexOf(row)));
    return { rows, between };
  });
}

beforeEach(() => {
  fx.signedIn = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[UI-SWEEP U-P1] Profile lists: one row shape per list', () => {
  it('YOUR ACCOUNT: every row is the kit row with its icon tile, "Your rating" included (star)', async () => {
    await render();
    const account = lists().find((l) => l.rows.some((r) => r.dataset['row'] === 'Personal data'));
    expect(account, 'the YOUR ACCOUNT list').toBeDefined();
    const labels = account!.rows.map((r) => r.dataset['row']);
    expect(labels).toEqual(['Personal data', 'My addresses', 'Emergency contacts', 'Blocked people', 'Your ID', 'Your rating']);
    for (const row of account!.rows) {
      expect(row.dataset['plain'], `${row.dataset['row']} has its icon tile`).toBe('false');
      expect(row.dataset['icon'], `${row.dataset['row']} names its icon`).not.toBe('');
    }
    expect(account!.rows.find((r) => r.dataset['row'] === 'Your rating')!.dataset['icon']).toBe('star');
  });

  it.each([
    ['signed in', true],
    ['as a guest', false],
  ] as const)('%s, no list mixes tiled and bare rows, and one divider sits between each pair', async (_case, signedIn) => {
    fx.signedIn = signedIn;
    await render();
    const all = lists();
    expect(all.length, 'the screen has lists').toBeGreaterThan(0);
    for (const list of all) {
      const names = list.rows.map((r) => r.dataset['row']).join(', ');
      expect(new Set(list.rows.map((r) => r.dataset['plain'])).size, `one row shape in: ${names}`).toBe(1);
    }
    if (signedIn) {
      for (const list of all) {
        for (const gap of list.between) {
          expect(gap, `one hairline between rows of: ${list.rows.map((r) => r.dataset['row']).join(', ')}`).toHaveLength(1);
          expect(gap[0]!.children, 'the divider is a bare line').toHaveLength(0);
        }
      }
    }
  });
});
