/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { QueryClientProvider } from '@tanstack/react-query';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { User } from '@swift/types';

// ---------------------------------------------------------------------------
// [Owner, 1 Oct · truth] The shift identity check promised "it’s matched
// against your profile photo" before anything was compared, and answered a
// check that could not run — the server's ERROR_FAIL_CLOSED, which is what an
// analyzer outage or face-matching switched off (FD-D5) produces — with "That
// selfie didn’t match your profile photo". Only a FAIL is a comparison that
// did not match.
//
// REAL: the screen, its liveness hook, the app's `api` client and the auth
// store, inside a real navigator. Stand-ins: native drawing, the camera (it
// hands back a photo), and the HTTP transport, a synthetic server.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ storage: new Map<string, string>() }));

vi.mock('react-native', async () => {
  const R = await import('react');
  const kids = (children: unknown) =>
    (typeof children === 'function' ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : children) as React.ReactNode;
  const View = ({ children }: any) => R.createElement('div', null, kids(children));
  class Value { constructor(public value = 0) {} setValue(value: number) { this.value = value; } interpolate() { return this; } stopAnimation() {} }
  const animation = () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }), stop() {} });
  return {
    View, ScrollView: View, Text: View, Image: () => null, ActivityIndicator: () => null,
    Pressable: ({ children, onPress }: any) => R.createElement('div', { role: 'button', onClick: () => onPress?.() }, kids(children)),
    Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default },
    I18nManager: { getConstants: () => ({ isRTL: false }) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View, timing: animation, spring: animation, parallel: animation, add: () => new Value(), multiply: () => new Value() },
    Easing: { inOut: (fn: unknown) => fn, in: (fn: unknown) => fn, out: (fn: unknown) => fn, ease: () => 0, linear: () => 0, poly: () => () => 0 },
    Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }) }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Linking: { openURL: async () => undefined, openSettings: async () => undefined, getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
    TurboModuleRegistry: { get: () => null },
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
vi.mock('@swift/ui', () => {
  const token: unknown = new Proxy({}, { get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, radius: token, space: token, withAlpha: () => '' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `liveness-truth-${++next}` }; });
// The camera: permission granted, and a press hands back a photo.
vi.mock('expo-camera', async () => {
  const R = await import('react');
  return {
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, async () => ({ granted: true })],
    CameraView: ({ ref }: any) => {
      R.useImperativeHandle(ref, () => ({ takePictureAsync: async () => ({ uri: 'file:///shift-selfie.jpg' }) }));
      return null;
    },
  };
});
vi.mock('../../../lib/storage', () => ({
  zustandStorage: {
    getItem: (key: string) => fx.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fx.storage.set(key, value); },
    removeItem: (key: string) => { fx.storage.delete(key); },
  },
}));
vi.mock('../../../lib/adsQueue', () => ({ retireAdEventScope: () => undefined }));
vi.mock('../../../lib/analytics', () => ({ track: () => undefined }));
vi.mock('../../../kit/toast', () => ({ toast: { show: () => undefined, error: () => undefined, success: () => undefined } }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return {
    Screen: Box,
    Header: ({ title }: any) => R.createElement('h1', null, title),
    T: ({ children }: any) => R.createElement('span', null, children),
    PillButton: ({ label, onPress, disabled }: any) =>
      R.createElement('div', { role: 'button', 'aria-label': label, onClick: disabled ? undefined : onPress }, label),
  };
});

import { useAuthStore } from '../../../stores/authStore';
import { api } from '../../../services/api';
import { queryClient } from '../../../lib/queryClient';
import { LivenessCheckScreen } from './LivenessCheckScreen';

/** What POST /safety/liveness-check answers. */
let verdict: Record<string, unknown> = {};
const posted: string[] = [];
function respond(config: InternalAxiosRequestConfig, status: number, data: unknown) {
  const response = { config, status, statusText: String(status), headers: {}, data };
  if (status >= 200 && status < 300) return response;
  throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response as never);
}
async function transport(config: InternalAxiosRequestConfig) {
  const method = String(config.method ?? 'get').toUpperCase();
  const url = String(config.url ?? '');
  if (method === 'POST' && url === '/safety/liveness-check?profile=RIDER') {
    posted.push(url);
    return respond(config, 200, { success: true, data: verdict });
  }
  return respond(config, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

const Stack = createNativeStackNavigator();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalAdapter = api.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
const text = () => host.textContent ?? '';
async function settle(ms = 120) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function press(label: string) {
  const target = Array.from(host.querySelectorAll<HTMLElement>('[role=button]')).find((b) => b.getAttribute('aria-label') === label);
  if (!target) throw new Error(`no "${label}" on screen: ${text()}`);
  await act(async () => { target.click(); });
  await settle();
}

/** A rider asked for the shift check opens it, takes the selfie and sends it. */
async function riderSendsShiftSelfie() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(NavigationContainer, null,
      React.createElement(Stack.Navigator, {
        screenOptions: { headerShown: false },
        children: React.createElement(Stack.Screen, { name: 'LivenessCheck', component: LivenessCheckScreen, initialParams: { profile: 'RIDER' } }),
      })))));
  await settle();
  expect(text()).toContain('Identity check');
  await press('Take selfie');
  await press('Use this photo');
  expect(posted).toEqual(['/safety/liveness-check?profile=RIDER']);
}

beforeEach(() => {
  posted.length = 0;
  verdict = {};
  api.defaults.adapter = transport;
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => ({ config, status: 200, statusText: 'OK', headers: {}, data: {} });
  queryClient.clear();
  useAuthStore.getState().setAuth({
    id: 'rider-rae', firstName: 'Rae', lastName: 'Persaud', phone: '+5926000001', countryCode: 'GY',
    roles: ['CUSTOMER', 'MOVER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER', selfieCapturedAt: '2026-09-28T10:00:00Z',
  } as unknown as User, 'synthetic-access', 'synthetic-refresh');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await vi.dynamicImportSettled();
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  api.defaults.adapter = originalAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
});

describe('the shift identity check says only what the server did', () => {
  it('before anything is compared, it does not claim a comparison', async () => {
    await riderSendsShiftSelfie();
    expect(text()).not.toMatch(/matched against your profile photo/i);
  });

  it('a check that could not run is not called a mismatch', async () => {
    verdict = { checkId: 'check-1', outcome: 'ERROR_FAIL_CLOSED', allowedOnline: false };
    await riderSendsShiftSelfie();

    expect(text()).not.toMatch(/didn’t match|didn't match/);
    expect(text()).toContain('The identity check couldn’t run just now');
    expect(text()).not.toContain('You’re confirmed');
  });

  it('control: a real mismatch still says so, with the attempts left', async () => {
    verdict = { checkId: 'check-2', outcome: 'FAIL', allowedOnline: false, attemptsLeft: 2 };
    await riderSendsShiftSelfie();

    expect(text()).toContain('That selfie didn’t match your profile photo. You have 2 attempts left before the account locks.');
  });

  it('control: a pass confirms the shift', async () => {
    verdict = { checkId: 'check-3', outcome: 'PASS', allowedOnline: true };
    await riderSendsShiftSelfie();

    expect(text()).toContain('You’re confirmed');
    expect(text()).toContain('This check covers your current shift.');
  });
});
