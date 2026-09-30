import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Run the mounted mobile screen in the existing DOM test host. Native drawing
// primitives are replaced; the screen, search hooks, Axios transport and
// Fastify search/auth handlers execute. No device or network listener is used.
vi.mock('../../../mobile/node_modules/react-native', () => {
  const View = ({ children }: any) => <div>{children}</div>;
  return {
    View, ScrollView: View, FlatList: () => null,
    Pressable: ({ children, onPress, accessibilityLabel }: any) => <button aria-label={accessibilityLabel} onClick={onPress}>{typeof children === 'function' ? children({ pressed: false }) : children}</button>,
    TextInput: ({ onChangeText, ...p }: any) => <input value={p.value} placeholder={p.placeholder} onChange={(e) => onChangeText(e.target.value)} />,
    TurboModuleRegistry: { get: () => null },
  };
});
vi.mock('../../../mobile/node_modules/@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }), useRoute: () => ({ params: { q: 'Pepper' } }) }));
vi.mock('../../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../../mobile/node_modules/@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('../../../mobile/node_modules/expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('../../../mobile/src/stores/authStore', () => ({
  getAuthSessionSnapshot: () => null, isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: Object.assign(() => ({ user: null }), { getState: () => ({ user: null, accessToken: null, refreshToken: null }) }),
}));
vi.mock('../../../mobile/src/stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('../../../mobile/src/stores/locationStore', () => ({ useLocationStore: () => ({ latitude: null, longitude: null, status: 'denied' }) }));
vi.mock('../../../mobile/src/stores/appStore', () => ({ useAppStore: () => ({ recentSearches: [], pushSearch: () => {}, clearSearches: () => {} }) }));
vi.mock('../../../mobile/src/lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
// The Market-depth memory (#1316) persists through react-native-mmkv, a native
// module whose own react-native import would load the real (Flow-typed)
// package here. The mobile hook tests replace it the same way.
vi.mock('../../../mobile/src/lib/marketDepthMemory', () => ({ rememberedMarketDepth: () => null, rememberMarketDepth: () => {} }));
vi.mock('../../../mobile/src/kit/action-sheet', () => ({ ActionSheet: () => null }));
vi.mock('../../../mobile/src/kit', () => ({
  Screen: ({ children }: any) => <div>{children}</div>, T: ({ children }: any) => <span>{children}</span>,
  Chip: ({ label, onPress }: any) => <button onClick={onPress}>{label}</button>,
  EmptyState: () => <p>No matches</p>, ErrorState: () => <p>Connection error</p>, LoadingBlock: () => <p>Loading results</p>,
  Money: ({ amount }: any) => <span>{amount}</span>, Photo: () => null, RatingMeta: () => null,
  SectionHeader: ({ title }: any) => <h2>{title}</h2>,
  // [E09] the shared cart bar: no basket in this guest journey
  CartBar: () => null, useCartBarClearance: () => 0,
}));
vi.mock('../../../mobile/src/hooks/customer', async (original) => ({
  ...await original<any>(), useHome: () => ({ data: { popularItems: [] } }), useVendors: () => ({ data: [] }),
}));

// Variable imports keep this cross-surface test from adding mobile/API source
// to Next's production type-check graph. Each app has its own typecheck gate.
const mobileScreenPath = new URL('../../../mobile/src/modules/shop/screens/SearchScreen.tsx', import.meta.url).pathname;
const mobileApiPath = new URL('../../../mobile/src/services/api.ts', import.meta.url).pathname;
const harnessPath = new URL('../../../api/src/__tests__/helpers/guest-search.ts', import.meta.url).pathname;
let SearchScreen: React.ComponentType;
let api: any;
let guestSearchApp: any;
let app: any;
let client: QueryClient;
beforeAll(async () => {
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://api.test');
  ({ SearchScreen } = await import(mobileScreenPath));
  ({ api } = await import(mobileApiPath));
  ({ guestSearchApp } = await import(harnessPath));
});
afterEach(async () => { cleanup(); client?.clear(); await app?.close(); vi.unstubAllEnvs(); });

describe('mounted mobile guest catalogue search', () => {
  it('shows catalogue results and suggestions instead of a connection error', async () => {
    ({ app } = await guestSearchApp());
    const requests: { path: string; authorization: unknown; status: number }[] = [];
    api.defaults.adapter = async (config: any) => {
      const params = new URLSearchParams(Object.entries(config.params ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
      const path = `/api/v1${config.url}?${params}`;
      const response = await app.inject({ url: path });
      requests.push({ path, authorization: config.headers.get('Authorization'), status: response.statusCode });
      const result = { data: response.json(), status: response.statusCode, statusText: '', headers: {}, config };
      if (response.statusCode >= 400) throw Object.assign(new Error('HTTP error'), { response: result, config });
      return result;
    };
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SearchScreen /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Pepper dish public. Pepper public · Meals' })).not.toBeNull());
    expect(screen.queryByText('Connection error')).toBeNull();
    expect(screen.queryByText('Pepper dish other')).toBeNull();
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.map((r) => r.path.split('?')[0]).sort()).toEqual(['/api/v1/search', '/api/v1/search/suggestions', '/api/v1/search/trending']);
    expect(requests.every((r) => !r.authorization && r.status === 200)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Pepper dish public' })).not.toBeNull();
  });
});
