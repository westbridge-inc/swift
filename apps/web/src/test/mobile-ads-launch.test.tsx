import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), setIntent: vi.fn(), myAdvertisers: vi.fn(() => ({ data: [], isLoading: false, isError: false })), fetchAds: vi.fn(), startAdEventLoop: vi.fn() }));
vi.mock('../../../mobile/src/services/api', () => ({ api: { get: mocks.get } }));
vi.mock('../../../mobile/src/stores/authStore', () => ({ useAuthStore: (select: (_s: unknown) => unknown) => select({
  setIntent: mocks.setIntent, setMoverPreset: vi.fn(), setCountry: vi.fn(), promptLogin: vi.fn(),
}) }));
vi.mock('../../../mobile/src/stores/moverPreview', () => ({ useMoverPreview: () => vi.fn() }));
vi.mock('../../../mobile/src/stores/vendorPreview', () => ({ useVendorPreview: () => vi.fn() }));
vi.mock('../../../mobile/src/lib/haptics', () => ({ haptic: { select: vi.fn() } }));
vi.mock('../../../mobile/src/components/SwiftLogo', () => ({ SwiftMark: () => null }));
vi.mock('../../../mobile/src/kit', () => ({
  T: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Screen: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pictogram: () => null,
}));
vi.mock('../../../mobile/src/kit/pressable-scale', () => ({ PressableScale: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../../../mobile/node_modules/react-native', () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress, testID }: { children: React.ReactNode | ((_p: { pressed: boolean }) => React.ReactNode); onPress: () => void; testID: string }) =>
    <button data-testid={testID} onClick={onPress}>{typeof children === 'function' ? children({ pressed: false }) : children}</button>,
}));
vi.mock('../../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../../mobile/node_modules/@expo/vector-icons', () => ({ Feather: () => null }));

vi.mock('../../../mobile/src/hooks/advertiser', () => ({ useMyAdvertisers: mocks.myAdvertisers }));
vi.mock('../../../mobile/src/lib/ads', () => ({ fetchAds: mocks.fetchAds, startAdEventLoop: mocks.startAdEventLoop }));
vi.mock('../../../mobile/src/modules/advertiser/screens/AdvertiserRegisterScreen', () => ({ AdvertiserRegisterScreen: () => <span>Advertiser registration</span> }));
vi.mock('../../../mobile/src/modules/advertiser/screens/AdvertiserHomeScreen', () => ({ AdvertiserHomeScreen: () => null }));
vi.mock('../../../mobile/src/modules/advertiser/screens/NewCampaignScreen', () => ({ NewCampaignScreen: () => null }));
vi.mock('../../../mobile/src/modules/advertiser/screens/CampaignDetailScreen', () => ({ CampaignDetailScreen: () => null }));
vi.mock('../../../mobile/src/modules/advertiser/screens/AdvertiserBillingScreen', () => ({ AdvertiserBillingScreen: () => null }));
vi.mock('../../../mobile/src/modules/advertiser/screens/AdvertiserTeamScreen', () => ({ AdvertiserTeamScreen: () => null }));
vi.mock('../../../mobile/src/modules/profile/screens/GetHelpScreen', () => ({ GetHelpScreen: () => null }));
vi.mock('../../../mobile/src/modules/profile/screens/PersonalDataScreen', () => ({ PersonalDataScreen: () => null }));
vi.mock('../../../mobile/node_modules/@react-navigation/native-stack', () => ({ createNativeStackNavigator: () => ({
  Navigator: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Screen: ({ component: Component }: { component: React.ComponentType }) => <Component />,
}) }));
vi.mock('../../../mobile/node_modules/@react-navigation/bottom-tabs', () => ({ createBottomTabNavigator: () => ({}) }));
let AdvertiserStack: React.ComponentType;
let useAds: (_city: string) => { data?: unknown };
let RolePickerScreen: React.ComponentType;
beforeAll(async () => {
  ({ AdvertiserStack } = await import(new URL('../../../mobile/src/modules/advertiser/AdvertiserStack.tsx', import.meta.url).pathname));
  ({ useAds } = await import(new URL('../../../mobile/src/hooks/ads.ts', import.meta.url).pathname));
  ({ RolePickerScreen } = await import(new URL('../../../mobile/src/screens/auth/RolePickerScreen.tsx', import.meta.url).pathname));
});
afterEach(() => vi.clearAllMocks());
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><RolePickerScreen /></QueryClientProvider>);
  return client;
}

describe('advertising launch entry', () => {
  it.each([false, undefined, 'true', 1])('hides advertising unless server capability is true (%s)', async (adsEnabled) => {
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled } } });
    mount();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/public/capabilities'));
    expect(screen.queryByTestId('role-picker-advertiser')).toBeNull();
    expect(screen.getByText('Swift Business')).toBeTruthy();
  });
  it('hides advertising while loading and after an unavailable capability read', async () => {
    mocks.get.mockRejectedValue(new Error('offline'));
    mount();
    expect(screen.queryByTestId('role-picker-advertiser')).toBeNull();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(screen.queryByTestId('role-picker-advertiser')).toBeNull();
  });
  it('shows enabled advertising and removes the entry after a failed refresh', async () => {
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: true } } });
    const client = mount();
    await waitFor(() => expect(screen.getByTestId('role-picker-advertiser')).toBeTruthy());
    act(() => screen.getByTestId('role-picker-advertiser').click());
    expect(mocks.setIntent).toHaveBeenCalledWith('advertiser');
    mocks.get.mockRejectedValue(new Error('offline'));
    await act(async () => { await client.invalidateQueries(); });
    await waitFor(() => expect(screen.queryByTestId('role-picker-advertiser')).toBeNull());
  });
});

describe('saved advertising surfaces', () => {
  it('keeps a persisted advertiser intent out of registration while advertising is off', async () => {
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: false } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<QueryClientProvider client={client}><AdvertiserStack /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryByText('Advertiser registration')).toBeNull());
    expect(mocks.myAdvertisers).not.toHaveBeenCalled();
    expect(screen.getByText('Swift Business')).toBeTruthy();
  });
  it('still reaches advertiser registration when enabled', async () => {
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: true } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<QueryClientProvider client={client}><AdvertiserStack /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Advertiser registration')).toBeTruthy());
  });
  it('does not serve or expose cached home ads when disabled', async () => {
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: false } } });
    mocks.fetchAds.mockResolvedValue({ data: 'cached ad' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    client.setQueryData(['ads', 'serve', 'Georgetown', 'anonymous', undefined, undefined], { data: 'cached ad' });
    const { result } = renderHook(() => useAds('Georgetown'), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.fetchAds).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
  it('does not request home ads when disabled and the cache is empty', async () => {
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: false } } });
    mocks.fetchAds.mockResolvedValue({ data: 'unexpected ad' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { result } = renderHook(() => useAds('Georgetown'), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await waitFor(() => expect(client.getQueryState(['public', 'capabilities'])?.status).toBe('success'));
    expect(mocks.fetchAds).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
  it('removes already rendered home ads after a server shutdown', async () => {
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: true } } });
    mocks.fetchAds.mockResolvedValue({ data: 'live ad' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { result } = renderHook(() => useAds('Georgetown'), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await waitFor(() => expect(result.current.data).toEqual({ data: 'live ad' }));
    mocks.get.mockResolvedValue({ data: { success: true, data: { adsEnabled: false } } });
    await act(async () => { await client.invalidateQueries({ queryKey: ['public', 'capabilities'] }); });
    await waitFor(() => expect(result.current.data).toBeUndefined());
  });
});
