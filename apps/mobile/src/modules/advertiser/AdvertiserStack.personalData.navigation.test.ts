/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { NavigationContainer } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [DELETION-INTEGRITY · DS744 S4] The REAL AdvertiserStack (ads on), its REAL
// bottom tabs and the REAL Account & team screen, inside a real
// NavigationContainer: pressing "Personal data & account closure" must land on
// PersonalData on the root stack, as a closure request. A source-text census
// alone would pass on a row whose press does nothing. Only native drawing,
// data hooks and unrelated screens are stand-ins.
const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('../profile/screens/PersonalDataScreen', () => ({ PersonalDataScreen: 'PersonalDataScreen' }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, typeof children === 'function' ? children({ pressed: false }) : children);
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: View, Pressable: View, RefreshControl: View,
    Modal: ({ visible, children }: any) => visible ? R.createElement(View, null, children) : null,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, Vibration: { vibrate: vi.fn() }, AppState: { addEventListener: () => ({ remove() {} }) },
    Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) }, Share: { share: vi.fn() },
  };
});
vi.mock('@react-navigation/elements', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const SafeAreaProviderCompat = Object.assign(Box, { initialMetrics: { frame: { width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } } });
  return {
    SafeAreaProviderCompat, Screen: Box, Header: () => null, HeaderBackButton: () => null,
    HeaderBackContext: R.createContext(undefined), HeaderShownContext: R.createContext(false),
    HeaderHeightContext: R.createContext(0), useHeaderHeight: () => 0,
    getHeaderTitle: (_options: unknown, name: string) => name, getLabel: (options: any, fallback: string) => options.label ?? fallback,
    PlatformPressable: Box, Label: Box, Background: Box, Badge: () => null, MissingIcon: () => null,
    useFrameSize: () => ({ width: 390, height: 844 }), useLocale: () => ({ direction: 'ltr' }),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const R = await import('react');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return { SafeAreaInsetsContext: R.createContext(insets), useSafeAreaInsets: () => insets, SafeAreaProvider: ({ children }: any) => children };
});
vi.mock('react-native-screens', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { screensEnabled: () => false, Screen: Box, ScreenContainer: Box };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const Button = ({ label, onPress }: any) => R.createElement('button', { type: 'button', onClick: onPress }, label);
  return {
    Card: Box, T: Box, LabeledInput: () => null, PillButton: Button, TonePill: () => null,
    LoadingBlock: () => null, ErrorState: () => null, SettingsRow: Button,
  };
});
vi.mock('./AdvertiserExitDialog', () => ({ useAdvertiserExitDialog: () => ({ requestLogout: vi.fn(), logoutDialog: null }) }));
vi.mock('../../hooks/useAdsEnabled', () => ({ useAdsEnabled: () => true }));
vi.mock('../../hooks/advertiser', () => ({
  useMyAdvertisers: () => ({ isLoading: false, isError: false, data: [{ id: 'advertiser-a', companyName: 'Synthetic Ads' }] }),
  useAdvertiserMembers: () => ({ isLoading: false, isError: false, data: [{ userId: 'member-a', role: 'OWNER', name: 'Synthetic' }] }),
  useAdvertiserActions: () => ({ addMember: { mutate: vi.fn(), isPending: false } }),
}));
vi.mock('../../stores/authStore', () => {
  const state = { user: { id: 'member-a' }, setIntent: vi.fn() };
  return { useAuthStore: (selector?: (s: typeof state) => unknown) => selector ? selector(state) : state };
});
vi.mock('../../screens/auth/RolePickerScreen', () => ({ RolePickerScreen: () => null }));
vi.mock('./screens/AdvertiserRegisterScreen', () => ({ AdvertiserRegisterScreen: () => null }));
vi.mock('./screens/AdvertiserHomeScreen', () => ({ AdvertiserHomeScreen: () => null }));
vi.mock('./screens/NewCampaignScreen', () => ({ NewCampaignScreen: () => null }));
vi.mock('./screens/CampaignDetailScreen', () => ({ CampaignDetailScreen: () => null }));
vi.mock('./screens/AdvertiserBillingScreen', () => ({ AdvertiserBillingScreen: () => null }));
vi.mock('../profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));

import { navigationRef as navigation } from '../../navigation/navigationRef';
import { AdvertiserStack } from './AdvertiserStack';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(el => el.textContent === label);
  expect(found, label).toBeDefined(); return found!;
}

describe('[DELETION-INTEGRITY] an advertiser reaches account closure from Account & team', () => {
  it('the Account row opens personal data as a closure request in the real navigator', async () => {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client: new QueryClient() },
      React.createElement(NavigationContainer<Record<string, object | undefined>>, {
        ref: navigation, linking: { enabled: false, prefixes: [] }, children: React.createElement(AdvertiserStack),
      }))));
    await act(async () => navigation.navigate('AdvTabs', { screen: 'AdvTeam' }));
    expect(navigation.getCurrentRoute()?.name).toBe('AdvTeam');
    expect(host.querySelector('personaldatascreen')).toBeNull();

    await act(async () => button('Personal data & account closure').click());
    const route = navigation.getCurrentRoute()!;
    expect(route.name).toBe('PersonalData');
    expect(route.params).toEqual({ closureRequest: true });
    expect(host.querySelector('personaldatascreen')).not.toBeNull();
  });
});
