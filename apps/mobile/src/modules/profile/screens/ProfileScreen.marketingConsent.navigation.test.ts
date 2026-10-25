/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [UI-SWEEP U71] Account -> "Marketing messages" is the consent switch the
// served consent text promises. When the consent read failed (or had not
// answered yet) the row said "Off — service messages only", so a person who
// had agreed to marketing was told they had not. A change that failed snapped
// back without a word. The REAL MarketingConsentRow with a REAL TanStack
// query and mutation; only native drawing, the kit and the network are
// stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getConsent: vi.fn(),
  setMarketingConsent: vi.fn(),
  toastError: vi.fn(),
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
vi.mock('react-native-reanimated', () => ({ default: { View: () => null }, FadeInDown: { duration: () => ({}) }, ReduceMotion: {} }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../lib/haptics', () => ({ haptic: vi.fn() }));
vi.mock('../../../hooks/customer', () => ({ useLiveOrders: vi.fn(), useMyRating: vi.fn(), useProfile: vi.fn() }));
vi.mock('../../../stores/authStore', () => ({ useAuthStore: vi.fn() }));
vi.mock('../../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: () => null }));
vi.mock('../../../services/api', () => ({
  API_URL: 'https://api.example.test',
  customerApi: { getConsent: fx.getConsent, setMarketingConsent: fx.setMarketingConsent },
}));
vi.mock('../../../lib/payLink', () => ({ openPayLink: vi.fn() }));
vi.mock('../../../lib/appQueryPolicy', () => ({ retryRead: () => false }));
vi.mock('../../../lib/customerIdCopy', () => ({ profileIdRowSub: () => '' }));
vi.mock('../../../kit/toast', () => ({ toast: { error: fx.toastError, success: vi.fn(), show: vi.fn() } }));
vi.mock('../../../kit/controls', async () => {
  const R = await import('react');
  return {
    BrandSwitch: (p: any) => R.createElement('input', {
      type: 'checkbox', role: 'switch', 'aria-label': p.label, checked: !!p.value, disabled: !!p.disabled,
      onChange: () => p.onChange(!p.value),
    }),
  };
});
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Nothing = () => null;
  return {
    EmptyState: Nothing, ErrorState: Nothing, IconChip: Nothing, LoadingBlock: Nothing, PillButton: Nothing,
    PopupCard: Nothing, PopupTitle: Nothing, Screen: Nothing, T: Nothing, TrustHalo: Nothing,
    useLogoutConfirm: () => ({ requestLogout: vi.fn(), logoutDialog: null }),
    Chip: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
    SettingsRow: (p: any) => h('section', null, h('h3', null, p.label), h('p', { 'data-sub': '' }, p.sub), p.right ?? null),
  };
});

import { MarketingConsentRow } from './ProfileScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const sub = () => host.querySelector('[data-sub]')?.textContent ?? '';
const toggle = () => host.querySelector<HTMLInputElement>('input[role="switch"]');
const consentAnswer = (state: string | null) => ({ data: { data: { consents: [{ documentType: 'marketing_consent', state }] } } });
async function mount() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MarketingConsentRow))));
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe('[UI-SWEEP U71] the marketing switch never states a choice it does not know', () => {
  it('a failed consent read says so and offers Try again, never "Off"', async () => {
    fx.getConsent.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(consentAnswer('granted'));
    await mount();
    await settle();
    expect(sub()).not.toMatch(/^Off/);
    expect(sub()).toContain('Could not load your choice');
    expect(toggle(), 'no switch to flip while the choice is unknown').toBeNull();
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again')!;
    await act(async () => { retry.click(); });
    await settle();
    expect(sub()).toMatch(/^On/);
    expect(toggle()!.checked).toBe(true);
  });

  it('while the read has not answered, the row claims neither On nor Off', async () => {
    fx.getConsent.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(sub()).not.toMatch(/^(On|Off)/);
    expect(toggle()?.disabled ?? true).toBe(true);
  });

  it('a change that fails is said out loud, and the switch shows the real choice', async () => {
    fx.getConsent.mockResolvedValue(consentAnswer('granted'));
    fx.setMarketingConsent.mockRejectedValue(new Error('offline'));
    await mount();
    await settle();
    await act(async () => { toggle()!.click(); });
    await settle();
    expect(fx.setMarketingConsent).toHaveBeenCalledWith(false);
    expect(fx.toastError).toHaveBeenCalledTimes(1);
    expect(fx.toastError.mock.calls[0]![0]).toContain('Marketing messages were not changed');
    expect(toggle()!.checked).toBe(true);
    expect(sub()).toMatch(/^On/);
  });

  it('a known choice still reads and flips as before', async () => {
    fx.getConsent.mockResolvedValue(consentAnswer('withdrawn'));
    fx.setMarketingConsent.mockResolvedValue({ data: { data: {} } });
    await mount();
    await settle();
    expect(sub()).toMatch(/^Off/);
    await act(async () => { toggle()!.click(); });
    await settle();
    expect(fx.setMarketingConsent).toHaveBeenCalledWith(true);
    expect(fx.toastError).not.toHaveBeenCalled();
  });
});

describe('[#1946 review S4-1] an accepted change is never shown as the old choice', () => {
  it('when the confirming re-read fails, the row keeps the choice the server accepted', async () => {
    fx.getConsent.mockResolvedValueOnce(consentAnswer('withdrawn')).mockRejectedValueOnce(new Error('offline'));
    fx.setMarketingConsent.mockResolvedValue({ data: { data: {} } });
    await mount();
    await settle();
    expect(sub()).toMatch(/^Off/);
    await act(async () => { toggle()!.click(); });
    await settle();
    expect(fx.getConsent, 'the change was followed by a re-read').toHaveBeenCalledTimes(2);
    expect(sub()).toMatch(/^On/);
    expect(toggle()!.checked).toBe(true);
  });

  it('a newer read that answers is the choice again', async () => {
    fx.getConsent.mockResolvedValueOnce(consentAnswer('withdrawn')).mockResolvedValueOnce(consentAnswer('withdrawn'));
    fx.setMarketingConsent.mockResolvedValue({ data: { data: {} } });
    await mount();
    await settle();
    await act(async () => { toggle()!.click(); });
    await settle();
    expect(fx.getConsent).toHaveBeenCalledTimes(2);
    expect(sub()).toMatch(/^Off/);
    expect(toggle()!.checked).toBe(false);
  });
});

// Already true on main (TanStack 5: a refetch with no data is pending again);
// pinned so the row never keeps the failure words while it re-reads.
describe('[#1946 review S4-2] Try again shows it is checking', () => {
  it('while the re-read runs, the row says "Checking your choice…" and the Try again chip is gone', async () => {
    fx.getConsent.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(new Promise(() => {}));
    await mount();
    await settle();
    expect(sub()).toContain('Could not load your choice');
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again')!;
    await act(async () => { retry.click(); });
    await settle();
    expect(sub()).toBe('Checking your choice…');
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Try again')).toBe(false);
    expect(toggle()?.disabled ?? true).toBe(true);
  });
});
