import axios, { type InternalAxiosRequestConfig } from 'axios';
import type { User } from '@swift/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app's REAL `api` client, REAL auth store and REAL earner-preview store.
// Only the native edges and the HTTP transport are fakes: the transport records
// every request that would have left the phone.
vi.mock('../kit/toast', () => ({ toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem() {}, removeItem() {} } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope() {} }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `preview-guard-fixture-${++next}` }; });
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null }, Platform: { OS: 'ios' } }));
vi.mock('../services/push', () => ({ preparePushTokenForLogout: async () => null }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => {} }));
vi.mock('../services/socket', () => ({ disconnectSocket() {} }));

import { useAuthStore } from '../stores/authStore';
import { useMoverPreview } from '../stores/moverPreview';
import { api, driverApi, partnerApi, riderApi } from './api';

const originalAdapter = api.defaults.adapter;
const originalAxiosAdapter = axios.defaults.adapter;
const wire: string[] = [];

function signedInMover() {
  useAuthStore.getState().setAuth(
    { id: 'mover-1', roles: ['CUSTOMER', 'MOVER', 'RIDER'], activeRole: 'RIDER', firstName: 'Fixture' } as unknown as User,
    'synthetic-access', 'synthetic-refresh',
  );
  useAuthStore.setState({ intent: 'mover' });
}

beforeEach(() => {
  wire.length = 0;
  // Re-signing in revokes the previous fixture session through raw axios; it
  // must land here, never on a network.
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => ({ config, status: 200, statusText: 'OK', headers: {}, data: {} });
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    wire.push(`${String(config.method).toUpperCase()} ${config.url}`);
    return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: {} } };
  };
  useMoverPreview.setState({ preview: false });
  signedInMover();
});
afterEach(async () => {
  // Let any session teardown finish on the fake transport, then leave no
  // session behind, so the next sign-in has nothing to revoke.
  await vi.dynamicImportSettled();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: null });
  api.defaults.adapter = originalAdapter;
  axios.defaults.adapter = originalAxiosAdapter;
  useMoverPreview.setState({ preview: false });
});

// While the earner preview is on screen, NOTHING the preview does can be
// written: a signed-in rider or driver who opened "Preview your dashboard"
// from their documents is still holding a real session, so any write that
// reached the server would change their real account.
describe('the earner preview cannot write through the app client', () => {
  it('no write request leaves the phone while the preview is on screen', async () => {
    useMoverPreview.setState({ preview: true, kind: 'RIDER' });

    const writes: Array<[string, () => Promise<unknown>]> = [
      ['go online', () => riderApi.goOnline(6.8, -58.15)],
      ['accept a job', () => riderApi.accept('order-1')],
      ['save the MMG link', () => driverApi.updateProfile({ mmgPayUrl: 'https://example.test/pay' })],
      ['cancel the staged MMG link', () => driverApi.cancelPendingMmgLink()],
      ['change vehicle', () => partnerApi.changeVehicle({ vehicleType: 'BICYCLE' })],
      ['a raw PATCH', () => api.patch('/rider/anything', {})],
    ];
    for (const [label, write] of writes) {
      await expect(write(), label).rejects.toMatchObject({ code: 'PREVIEW_READ_ONLY' });
    }
    expect(wire, 'nothing reached the transport').toEqual([]);
  });

  it('reads still work in the preview (the public price list)', async () => {
    useMoverPreview.setState({ preview: true, kind: 'DRIVER' });
    await api.get('/auth/pricing');
    expect(wire).toEqual(['GET /auth/pricing']);
  });

  it('outside the preview the same writes reach the server', async () => {
    await riderApi.goOnline(6.8, -58.15);
    await driverApi.updateProfile({ mmgPayUrl: null });
    expect(wire).toEqual(['POST /rider/go-online', 'PUT /driver/profile']);
  });

  it('a preview flag left behind never blocks another part of the app', async () => {
    // The guard's own condition: only the mover app shows the preview. (The
    // preview also ENDS when anything takes the person out of it — proven
    // through the real router in navigation/RootNavigator.moverPreview.navigation.test.ts.)
    useMoverPreview.setState({ preview: true, kind: 'RIDER' });
    useAuthStore.setState({ intent: 'customer' });
    await api.post('/customer/orders', {});
    expect(wire).toEqual(['POST /customer/orders']);
  });
});

// The guard must not depend on the HTTP transport behaving: it never reaches it.
describe('the refusal is local and plain', () => {
  it('says so in plain words and carries no invented server response', async () => {
    useMoverPreview.setState({ preview: true, kind: 'DRIVER' });
    const refusal = await riderApi.goOffline().then(() => null, (e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'PREVIEW_READ_ONLY', message: 'This is a preview — nothing was changed.' });
    expect((refusal as { response?: unknown }).response).toBeUndefined();
    expect(axios.isAxiosError(refusal)).toBe(false);
    expect(wire).toEqual([]);
  });
});
