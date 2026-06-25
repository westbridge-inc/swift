import type { ExpoConfig } from 'expo/config';

// Two store apps are built from this one codebase (see src/lib/appVariant.ts).
// The variant is fixed at build time by EXPO_PUBLIC_APP_VARIANT (set per EAS build
// profile in eas.json); a plain `expo start` defaults to the customer app.
const VARIANT = process.env['EXPO_PUBLIC_APP_VARIANT'] === 'partner' ? 'partner' : 'customer';
const isPartner = VARIANT === 'partner';

const BUNDLE_ID = isPartner ? 'gy.swift.partner' : 'gy.swift.app';
const APP_NAME = isPartner ? 'Swift Partner' : 'Swift';
// Native Xcode project/module name — must NOT be exactly "Swift" (reserved by the
// Swift standard library → iOS build error TS "Module name 'Swift' is reserved").
// The user-visible name stays APP_NAME via ios.infoPlist.CFBundleDisplayName.
const PROJECT_NAME = isPartner ? 'Swift Partner' : 'SwiftGY';

const locationWhenInUse =
  'Swift uses your location to set your pickup and find nearby drivers and couriers.';
const locationAlways =
  'Swift Partner keeps your live position on the map in the background while you are online for jobs.';

const config: ExpoConfig = {
  name: PROJECT_NAME,
  slug: isPartner ? 'swift-partner' : 'swift',
  scheme: isPartner ? 'swiftpartner' : 'swift',
  version: '1.0.0',
  icon: isPartner ? './assets/icon-partner.png' : './assets/icon.png',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  backgroundColor: '#FFFFFF',
  splash: {
    backgroundColor: '#FFFFFF',
    resizeMode: 'contain',
  },
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: true,
    infoPlist: {
      CFBundleDisplayName: APP_NAME,
      NSLocationWhenInUseUsageDescription: locationWhenInUse,
      // Partner streams GPS while online → needs background location + push delivery.
      ...(isPartner
        ? {
            NSLocationAlwaysAndWhenInUseUsageDescription: locationAlways,
            UIBackgroundModes: ['location', 'remote-notification', 'fetch'],
          }
        : {}),
    },
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: { backgroundColor: '#FFFFFF' },
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      ...(isPartner
        ? [
            'ACCESS_BACKGROUND_LOCATION',
            'FOREGROUND_SERVICE',
            'FOREGROUND_SERVICE_LOCATION',
            'POST_NOTIFICATIONS',
          ]
        : []),
    ],
  },
  plugins: [
    'expo-font',
    'expo-splash-screen',
    'react-native-maps',
    'expo-image',
    'expo-secure-store',
    [
      'expo-location',
      {
        locationWhenInUsePermission: locationWhenInUse,
        ...(isPartner
          ? {
              locationAlwaysAndWhenInUsePermission: locationAlways,
              isAndroidBackgroundLocationEnabled: true,
              isAndroidForegroundServiceEnabled: true,
            }
          : {}),
      },
    ],
  ],
  extra: {
    variant: VARIANT,
    // Each app is its own EAS project. After `eas init` per variant, set EAS_PROJECT_ID
    // in that build's env; left unset, EAS resolves the project by slug as before.
    ...(process.env['EAS_PROJECT_ID'] ? { eas: { projectId: process.env['EAS_PROJECT_ID'] } } : {}),
  },
};

export default config;
