import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), setIntent: vi.fn() }));
vi.mock('../../../mobile/src/services/api', () => ({ api: { get: mocks.get } }));
vi.mock('../../../mobile/src/stores/authStore', () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({
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
  Pressable: ({ children, onPress, testID }: { children: React.ReactNode | ((p: { pressed: boolean }) => React.ReactNode); onPress: () => void; testID: string }) =>
    <button data-testid={testID} onClick={onPress}>{typeof children === 'function' ? children({ pressed: false }) : children}</button>,
}));
vi.mock('../../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../../mobile/node_modules/@expo/vector-icons', () => ({ Feather: () => null }));

let RolePickerScreen: React.ComponentType;
beforeAll(async () => {
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
