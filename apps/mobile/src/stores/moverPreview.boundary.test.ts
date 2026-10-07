import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@swift/types';

// The REAL auth store and the REAL earner-preview store. Only storage and the
// lazily-imported native/network teardown are fakes (as in authStore.test.ts).
vi.mock('../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem() {}, removeItem() {} } }));
vi.mock('../lib/queryClient', () => ({ queryClient: { clear: vi.fn() } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope: vi.fn() }));
vi.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `mover-preview-boundary-${++next}` }; });
vi.mock('../services/push', () => ({ preparePushTokenForLogout: async () => null }));
vi.mock('../services/api', () => ({ revokeAuthSession: async () => undefined }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation: async () => undefined }));
vi.mock('../services/socket', () => ({ disconnectSocket: () => undefined }));
vi.mock('./storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ setSelectedStore: () => undefined }) } }));

import { getAuthSessionSnapshot, useAuthStore } from './authStore';
import { useMoverPreview } from './moverPreview';

function mover(id: string): User {
  return { id, firstName: id, lastName: 'Test', phone: `+592${id}`, roles: ['CUSTOMER', 'MOVER', 'RIDER'], activeRole: 'RIDER', selfieCapturedAt: new Date(0).toISOString() } as unknown as User;
}

function signedInMoverAtTheirDocuments(id = 'rider-a') {
  useAuthStore.getState().setAuth(mover(id), `access-${id}`, `refresh-${id}`);
  useAuthStore.setState({ intent: 'mover', countryCode: 'GY' });
  // "Preview your dashboard" from the document area.
  useMoverPreview.getState().enterPreview('RIDER', 'documents');
  expect(useMoverPreview.getState()).toMatchObject({ preview: true, kind: 'RIDER' });
  return getAuthSessionSnapshot()!;
}

beforeEach(() => {
  useMoverPreview.getState().exitPreview();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: null });
});

describe('the earner preview store', () => {
  it('remembers which earner face to show and where the preview was opened from', () => {
    useMoverPreview.getState().enterPreview();
    expect(useMoverPreview.getState()).toMatchObject({ preview: true, kind: 'DRIVER', origin: 'welcome' });
    useMoverPreview.getState().enterPreview('RIDER', 'documents');
    expect(useMoverPreview.getState()).toMatchObject({ preview: true, kind: 'RIDER', origin: 'documents' });
    useMoverPreview.getState().exitPreview();
    expect(useMoverPreview.getState().preview).toBe(false);
  });

  it('anything that is not one of the two faces or origins opens the safe default', () => {
    // A press event from a button bound straight to the action must not become a "kind".
    useMoverPreview.getState().enterPreview({ nativeEvent: {} } as never, { target: 1 } as never);
    expect(useMoverPreview.getState()).toMatchObject({ preview: true, kind: 'DRIVER', origin: 'welcome' });
  });
});

// The preview is principal-scoped, exactly like the vendor sample dashboard: a
// signed-in rider's preview must never survive into a signed-out welcome screen
// or another account's session (where "Become a Swift Driver" would reopen the
// sample instead of sign-in, and the next mover would start inside a preview).
describe('the earner preview never crosses a session boundary', () => {
  it('log out ends the preview', () => {
    signedInMoverAtTheirDocuments();
    useAuthStore.getState().logout();
    expect(useMoverPreview.getState().preview).toBe(false);
  });

  it('a session that expires ends the preview', () => {
    const captured = signedInMoverAtTheirDocuments();
    expect(useAuthStore.getState().logoutIfCurrent(captured)).toBe(true);
    expect(useMoverPreview.getState().preview).toBe(false);
  });

  it('another account signing in on this phone ends the preview', () => {
    signedInMoverAtTheirDocuments('rider-a');
    useAuthStore.getState().setAuth(mover('rider-b'), 'access-b', 'refresh-b');
    expect(useMoverPreview.getState().preview).toBe(false);
  });

  it('a guest who looked at the sample driver app and then signs in lands in their own account', () => {
    useMoverPreview.getState().enterPreview('DRIVER');
    useAuthStore.getState().setAuth(mover('rider-c'), 'access-c', 'refresh-c');
    expect(useMoverPreview.getState().preview).toBe(false);
  });
});
