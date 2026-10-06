import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Render the real root registration with native drawing/side effects replaced.
// The mobile StackRouter test separately exercises its auth key transition.
const state = vi.hoisted(() => ({ auth: {} as Record<string, unknown> }));
vi.mock('../../../mobile/src/stores/authStore', () => ({ useAuthStore: () => state.auth }));
vi.mock('../../../mobile/src/stores/moverPreview', () => ({ useMoverPreview: () => false }));
vi.mock('../../../mobile/src/stores/vendorPreview', () => ({ useVendorPreview: () => false }));
vi.mock('../../../mobile/src/hooks/useCustomerCountry', () => ({ useCustomerCountry: () => {} }));
vi.mock('../../../mobile/src/services/push', () => ({ registerIfGranted: vi.fn() }));
vi.mock('../../../mobile/src/services/notification-router', () => ({ installNotificationTapRouter: () => () => {}, flushPendingNavigation: vi.fn() }));
vi.mock('../../../mobile/src/services/deep-links', () => ({ installDeepLinkHandler: () => () => {}, flushPendingDeepLink: vi.fn() }));
vi.mock('../../../mobile/src/services/attribution', () => ({ ensureFirstLaunchClaim: vi.fn(), flushAttributedDestination: vi.fn() }));
vi.mock('../../../mobile/src/navigation/navigationRef', () => ({ navigationRef: { isReady: () => false }, safeNavigate: vi.fn() }));
vi.mock('../../../mobile/src/screens/QrOutcomeScreen', () => ({ QrOutcomeScreen: () => <span>QR outcome</span> }));
vi.mock('../../../mobile/src/screens/auth/RolePickerScreen', () => ({ RolePickerScreen: () => null }));
vi.mock('../../../mobile/src/screens/auth/SelfieCaptureScreen', () => ({ SelfieCaptureScreen: () => null }));
vi.mock('../../../mobile/src/navigation/AuthStack', () => ({ AuthStack: () => null }));
vi.mock('../../../mobile/src/navigation/CustomerStack', () => ({ CustomerStack: () => <span>Customer menu navigator</span> }));
vi.mock('../../../mobile/src/modules/mover/MoverStack', () => ({ MoverStack: () => null }));
vi.mock('../../../mobile/src/modules/vendor/VendorStack', () => ({ VendorStack: () => null }));
vi.mock('../../../mobile/src/modules/advertiser/AdvertiserStack', () => ({ AdvertiserStack: () => null }));
// The signed-in safety panel (an owner's live SOS) is native UI mounted beside the navigator.
vi.mock('../../../mobile/src/modules/safety/OwnedSafetyPanel', () => ({ OwnedSafetyPanel: () => null }));
vi.mock('../../../mobile/node_modules/@react-navigation/native', () => ({ NavigationContainer: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../../mobile/node_modules/@react-navigation/native-stack', () => ({ createNativeStackNavigator: () => ({
  Navigator: ({ children }: { children: React.ReactNode }) => <div data-testid="routes">{children}</div>,
  Screen: ({ name, navigationKey, component: Component }: { name: string; navigationKey?: string; component: React.ComponentType }) => <div data-testid={name} data-navigation-key={navigationKey}><Component /></div>,
}) }));

const path = new URL('../../../mobile/src/navigation/RootNavigator.tsx', import.meta.url).pathname;
let RootNavigator: React.ComponentType;
beforeAll(async () => { ({ RootNavigator } = await import(path)); });

describe('the public linked-store navigator is registered at every root entry gate', () => {
  it.each([
    [null, false, false, 'RolePicker'], ['customer', false, false, 'Main'],
    ['vendor', true, false, 'Main'], ['mover', true, false, 'Main'],
    ['customer', false, true, 'Auth'], ['vendor', true, false, 'Selfie'],
  ])('intent=%s signedIn=%s requestedAuth=%s gate=%s', (intent, isAuthenticated, wantsAuth, gate) => {
    state.auth = { intent, isAuthenticated, wantsAuth, countryCode: 'GY', user: gate === 'Selfie' ? {} : { selfieCapturedAt: '2026-01-01' }, sessionGeneration: 1 };
    render(<RootNavigator />);
    // Ordinary launch still opens its original gate; scans alone navigate to Storefront.
    expect(screen.getByTestId('routes').firstElementChild?.getAttribute('data-testid')).toBe(gate);
    expect(screen.getByTestId('QrOutcome').textContent).toBe('QR outcome');
    expect(screen.getByTestId('Storefront').textContent).toBe('Customer menu navigator');
    expect(screen.getByTestId('Storefront').getAttribute('data-navigation-key')).toBe(wantsAuth ? 'store-auth' : 'store-browse');
  });
});
