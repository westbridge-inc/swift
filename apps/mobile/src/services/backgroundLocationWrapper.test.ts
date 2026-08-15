import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

const mocks = vi.hoisted(() => {
  const session: AuthSessionSnapshot = {
    generation: 7,
    userId: 'wrapper-account',
    accessToken: 'wrapper-access',
    refreshToken: 'wrapper-refresh',
  };
  const state: {
    persisted: string | null;
    auth: AuthSessionSnapshot | null;
    mmkv: Map<string, string>;
  } = {
    persisted: null,
    auth: session,
    mmkv: new Map(),
  };
  return {
    session,
    state,
    getItemAsync: vi.fn(async () => state.persisted),
    setItemAsync: vi.fn(async (_key: string, raw: string) => {
      state.persisted = raw;
    }),
    deleteItemAsync: vi.fn(async () => {
      state.persisted = null;
    }),
    hasStartedLocationUpdatesAsync: vi.fn().mockResolvedValue(false),
    stopLocationUpdatesAsync: vi.fn().mockResolvedValue(undefined),
    driverLocation: vi.fn().mockResolvedValue({ data: { data: { accepted: true } } }),
    riderLocation: vi.fn().mockResolvedValue({ data: { data: { accepted: true } } }),
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 'balanced' },
  getForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  getBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  hasStartedLocationUpdatesAsync: mocks.hasStartedLocationUpdatesAsync,
  startLocationUpdatesAsync: vi.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: mocks.stopLocationUpdatesAsync,
}));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
  deleteItemAsync: mocks.deleteItemAsync,
}));
vi.mock('./api', () => ({
  driverApi: { location: mocks.driverLocation },
  riderApi: { location: mocks.riderLocation },
}));
vi.mock('../lib/queryClient', () => ({
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));
vi.mock('../lib/storage', () => ({
  initSecureStorage: vi.fn().mockResolvedValue(undefined),
  zustandStorage: {
    getItem: (key: string) => mocks.state.mmkv.get(key) ?? null,
    setItem: (key: string, value: string) => mocks.state.mmkv.set(key, value),
    removeItem: (key: string) => mocks.state.mmkv.delete(key),
  },
}));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => mocks.state.auth,
  useAuthStore: { persist: { rehydrate: vi.fn().mockResolvedValue(undefined) } },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.state.persisted = null;
  mocks.state.auth = mocks.session;
  mocks.state.mmkv.clear();
  mocks.getItemAsync.mockImplementation(async () => mocks.state.persisted);
  mocks.setItemAsync.mockImplementation(async (_key, raw) => {
    mocks.state.persisted = raw;
  });
  mocks.deleteItemAsync.mockImplementation(async () => {
    mocks.state.persisted = null;
  });
  mocks.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
  mocks.driverLocation.mockResolvedValue({ data: { data: { accepted: true } } });
});

describe('backgroundLocation Expo wrapper', () => {
  it('keeps one pinned foreground publisher when TaskManager is unavailable', async () => {
    const service = await import('./backgroundLocation');

    await expect(service.startMoverLocation('DRIVER', () => true)).resolves.toBe(false);
    await service.publishMoverLocation(
      'DRIVER',
      { latitude: 6.81234, longitude: -58.14321 },
      mocks.session,
    );
    await service.publishMoverLocation(
      'DRIVER',
      { latitude: 6.81234, longitude: -58.14321 },
      mocks.session,
    );

    expect(mocks.driverLocation).toHaveBeenCalledOnce();
    expect(mocks.driverLocation).toHaveBeenCalledWith(
      6.81234,
      -58.14321,
      mocks.session,
    );
    expect(mocks.setItemAsync).not.toHaveBeenCalled();
    await expect(service.stopMoverLocation(mocks.session)).resolves.toBe(true);
  });
});
