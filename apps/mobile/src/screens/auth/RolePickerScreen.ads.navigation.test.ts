/// <reference lib="dom" />
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error the workspace web package owns the test-only DOM renderer.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fx = vi.hoisted(() => ({ get: vi.fn(), setIntent: vi.fn(), advertisers: vi.fn() }));
vi.mock('../../services/api', () => ({ api: { get: fx.get } }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null,
    typeof children === 'function' ? children({ pressed: false }) : children);
  return { View: Box, ScrollView: Box, Pressable: ({ children, onPress, accessibilityLabel }: any) =>
    R.createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel },
      typeof children === 'function' ? children({ pressed: false }) : children) };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@swift/ui', () => ({ color: { brand: { 500: '#803B3B' }, border: {}, text: {}, surface: {} }, radius: {}, space: {} }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { Screen: Box, T: Box, Pictogram: () => null, LoadingBlock: () => null, ErrorState: () => null };
});
vi.mock('../../kit/pressable-scale', async () => {
  const R = await import('react');
  return { PressableScale: ({ children, onPress }: any) => R.createElement('button', { onClick: onPress }, children) };
});
vi.mock('../../components/SwiftLogo', () => ({ SwiftMark: () => null }));
vi.mock('../../lib/haptics', () => ({ haptic: { select: () => undefined } }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (selector: any) => selector({
  setIntent: fx.setIntent, setCountry: () => undefined, setMoverPreset: () => undefined, promptLogin: () => undefined,
}) }));
vi.mock('../../stores/moverPreview', () => ({ useMoverPreview: (selector: any) => selector({ enterPreview: () => undefined }) }));
vi.mock('../../stores/vendorPreview', () => ({ useVendorPreview: (selector: any) => selector({ enterPreview: () => undefined }) }));
vi.mock('../../hooks/advertiser', () => ({ useMyAdvertisers: fx.advertisers }));
vi.mock('@react-navigation/native-stack', () => ({ createNativeStackNavigator: () => ({ Navigator: () => null, Screen: () => null }) }));
vi.mock('@react-navigation/bottom-tabs', () => ({ createBottomTabNavigator: () => ({ Navigator: () => null, Screen: () => null }) }));
vi.mock('../../modules/advertiser/screens/AdvertiserRegisterScreen', () => ({ AdvertiserRegisterScreen: () => null }));
vi.mock('../../modules/advertiser/screens/AdvertiserHomeScreen', () => ({ AdvertiserHomeScreen: () => null }));
vi.mock('../../modules/advertiser/screens/NewCampaignScreen', () => ({ NewCampaignScreen: () => null }));
vi.mock('../../modules/advertiser/screens/CampaignDetailScreen', () => ({ CampaignDetailScreen: () => null }));
vi.mock('../../modules/advertiser/screens/AdvertiserBillingScreen', () => ({ AdvertiserBillingScreen: () => null }));
vi.mock('../../modules/advertiser/screens/AdvertiserTeamScreen', () => ({ AdvertiserTeamScreen: () => null }));
vi.mock('../../modules/profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));

import { RolePickerScreen } from './RolePickerScreen';
import { AdvertiserStack } from '../../modules/advertiser/AdvertiserStack';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const visible = () => host.textContent?.includes('Advertise on Swift') ?? false;
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); };
async function mount(Component = RolePickerScreen) {
  await act(async () => { root.render(React.createElement(QueryClientProvider, { client, children: React.createElement(Component) })); });
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks();
  fx.advertisers.mockReturnValue({ data: [], isLoading: false, isError: false });
  host = document.createElement('div');
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); });

describe('the server decides whether advertising has an entry', () => {
  it.each([
    { success: true, data: { adsEnabled: false } },
    { success: true, data: {} },
    { success: true, data: { adsEnabled: 'true' } },
    { success: false, data: { adsEnabled: true } },
  ])('hides the entry for a disabled or malformed capability: %j', async (body) => {
    fx.get.mockResolvedValue({ data: body });
    await mount();
    expect(visible()).toBe(false);
    expect(host.textContent).toContain('Swift Business');
    expect(host.textContent).toContain('Preview the driver app');
  });

  it('stays hidden while the capability request is pending', async () => {
    fx.get.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(visible()).toBe(false);
  });

  it('stays hidden when an older server lacks the capability endpoint', async () => {
    fx.get.mockRejectedValue(new Error('404'));
    await mount();
    expect(visible()).toBe(false);
  });

  it('a successful true response shows a working entry', async () => {
    fx.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: true } } });
    await mount();
    expect(fx.get).toHaveBeenCalledWith('/public/capabilities');
    expect(visible()).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Advertise on Swift"]')!.click());
    expect(fx.setIntent).toHaveBeenCalledWith('advertiser');
  });

  it('a cached opt-in cannot expose entry before this mount confirms it', async () => {
    client.setQueryData(['public', 'capabilities'], true);
    fx.get.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(visible()).toBe(false);
  });

  it.each(['off', 'error'])('a %s refresh closes an entry that was previously open', async (outcome) => {
    fx.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: true } } });
    await mount();
    expect(visible()).toBe(true);
    if (outcome === 'off') fx.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: false } } });
    else fx.get.mockRejectedValue(new Error('offline'));
    await act(async () => { await client.invalidateQueries({ queryKey: ['public', 'capabilities'] }); });
    await settle();
    expect(visible()).toBe(false);
  });

  it('a saved advertiser intent returns to the picker without sending an ads request while off', async () => {
    fx.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: false } } });
    await mount(AdvertiserStack);
    expect(host.textContent).toContain('Swift Business');
    expect(visible()).toBe(false);
    expect(fx.advertisers).not.toHaveBeenCalled();
  });
});
