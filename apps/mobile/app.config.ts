import type { ExpoConfig } from 'expo/config';

// One "Swift" app. The role you pick on the entry screen ("How will you use
// Swift?") chooses the experience at runtime — there is no longer a build-time
// variant. Background location + push belong to the driver/rider flow and are
// only *requested* when a user becomes a mover.
const locationWhenInUse =
  'Swift uses your location to set your pickup and find nearby stores, drivers and couriers.';
const locationAlways =
  'Swift keeps your live position on the map while you are online for deliveries or rides.';
const cameraPermission =
  'Swift uses the camera for your profile selfie and to photograph documents and deliveries.';

const config: ExpoConfig = {
  // Native project/module name — 'Swift' itself is reserved by Apple's
  // standard library, so the Xcode target needs a distinct name. What users
  // see is CFBundleDisplayName below: 'Swift'.
  name: 'SwiftGY',
  slug: 'swift',
  scheme: 'swift',
  version: '1.0.0',
  icon: './assets/icon.png',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  backgroundColor: '#FFFFFF',
  splash: {
    backgroundColor: '#FFFFFF',
    resizeMode: 'contain',
  },
  ios: {
    bundleIdentifier: 'gy.swift.app',
    supportsTablet: true,
    infoPlist: {
      CFBundleDisplayName: 'Swift',
      NSLocationWhenInUseUsageDescription: locationWhenInUse,
      NSLocationAlwaysAndWhenInUseUsageDescription: locationAlways,
      UIBackgroundModes: ['location', 'remote-notification', 'fetch'],
    },
  },
  android: {
    package: 'gy.swift.app',
    adaptiveIcon: { backgroundColor: '#FFFFFF' },
    // iOS uses Apple Maps (PROVIDER_DEFAULT, no key). Android's react-native-maps
    // is always Google-backed and renders a BLANK map without a key — set
    // ANDROID_GOOGLE_MAPS_API_KEY in the build env (EAS secret / prebuild env,
    // never committed). Restrict the key to this package name + SHA-1.
    ...(process.env['ANDROID_GOOGLE_MAPS_API_KEY']
      ? { config: { googleMaps: { apiKey: process.env['ANDROID_GOOGLE_MAPS_API_KEY'] } } }
      : {}),
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'POST_NOTIFICATIONS',
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
        locationAlwaysAndWhenInUsePermission: locationAlways,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission,
      },
    ],
  ],
  extra: {
    ...(process.env['EAS_PROJECT_ID'] ? { eas: { projectId: process.env['EAS_PROJECT_ID'] } } : {}),
  },
};

export default config;
