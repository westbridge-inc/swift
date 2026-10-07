/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import type { User } from '@swift/types';
import type { FeeSubscription } from '../../../lib/weeklyFee';

// [AX449 #1] Account A's fee notice is still resolving (or failed) when A logs
// out or another account signs in. The REAL auth store transitions, the REAL
// store switcher, the REAL notice resolver and the REAL WeeklyFeeScreen, drawn
// by a real React renderer for every fee family: B must be able to pay without
// another notification. Only native drawing, storage, crypto and transport
// are fakes.
const fx = vi.hoisted(() => ({ subscription: vi.fn(), sequence: 0 }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  return { View, ScrollView: View, RefreshControl: () => null, AppState: { addEventListener: () => ({ remove: () => undefined }) } };
});
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined, useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `synthetic-scope-${++fx.sequence}` }));
vi.mock('@swift/ui', () => ({ space: {} }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return {
    Card: Box, Screen: Box, T: Box, Header: () => null, LoadingBlock: () => null, ErrorState: () => null,
    PillButton: ({ label, onPress }: any) => R.createElement('button', { onClick: onPress }, label),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } }));
vi.mock('../../../lib/adsQueue', () => ({ retireAdEventScope: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../services/api', () => ({
  vendorApi: { subscription: fx.subscription },
  weeklyFeeApi: () => ({ start: vi.fn(), read: vi.fn(async () => null) }),
  revokeAuthSession: vi.fn(async () => undefined),
}));
vi.mock('../../../services/socket', () => ({ disconnectSocket: vi.fn(), reconnectSocketForStoreHandoff: vi.fn() }));
vi.mock('../../../services/backgroundLocation', () => ({ stopMoverLocation: vi.fn() }));
vi.mock('../../../services/push', () => ({ preparePushTokenForLogout: vi.fn(async () => null) }));
import { useAuthStore } from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { queryClient } from '../../../lib/queryClient';
import { resolveFeeNotification } from '../../../services/weekly-fee-notification';
import { WeeklyFeeScreen } from './WeeklyFeeScreen';

const live: FeeSubscription = { status: 'ACTIVE', payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] };
const PAY = 'Pay GY$1,200 with MMG';
const STUCK = "Couldn't open the notified store's weekly fee.";
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
/** A fresh mount of the real screen for one fee family, as the signed-in account. */
async function screen(family: 'vendor' | 'rider' | 'driver'): Promise<string> {
  await act(async () => root.render(React.createElement(WeeklyFeeScreen, { key: `${family}-${fx.sequence}`, family, sub: live, refresh: vi.fn() })));
  return host.textContent ?? '';
}
function signIn(id: string) {
  useAuthStore.getState().setAuth({ id, roles: ['VENDOR', 'RIDER', 'DRIVER'], activeRole: 'VENDOR' } as unknown as User, 'synthetic-access', 'synthetic-refresh');
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, isAuthenticated: false, accessToken: null, refreshToken: null, sessionGeneration: 0 });
  useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: false, feeContextError: null });
  signIn('account-A');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); queryClient.clear(); });

describe('R3 the next account can pay every weekly fee', () => {
  it.each([
    ['pending', 'logout-login'], ['pending', 'interactive-login'], ['failed', 'logout-login'], ['failed', 'interactive-login'],
  ] as const)('after A’s %s notice and a real %s, B sees Pay on vendor, rider and driver fees', async (phase, boundary) => {
    if (phase === 'pending') fx.subscription.mockImplementation(() => new Promise(() => undefined));
    else fx.subscription.mockRejectedValue({ response: { status: 503 } });
    const old = resolveFeeNotification({ vendorId: 'store-A', subscriptionId: 'subscription-A', ref: 'ref-A' }, vi.fn());
    if (phase === 'failed') await old;
    // While A's own notice is unresolved, A's Pay is held: the guard it exists for.
    expect(await screen('vendor')).not.toContain(PAY);
    if (boundary === 'logout-login') await act(async () => useAuthStore.getState().logout());
    await act(async () => signIn('account-B'));
    for (const family of ['vendor', 'rider', 'driver'] as const) {
      const rendered = await screen(family);
      expect(rendered, family).toContain(PAY);
      expect(rendered, family).not.toContain(STUCK);
    }
  });
});
