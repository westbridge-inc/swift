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
const photosPermission =
  'Swift needs your photo library so you can attach an existing photo to a delivery, a document or a support message.';

/**
 * APP PRIVACY MANIFEST [Apple, required since Nov 2024].
 *
 * The generated `ios/PrivacyInfo.xcprivacy` is Expo's stock default, and its
 * `NSPrivacyCollectedDataTypes` is an EMPTY ARRAY — for an app that collects
 * precise location, a phone number, photographs, government ID documents and a
 * selfie. That empty array flatly contradicts the App Privacy label, so it is
 * declared here instead: `app.config.ts` is the only file that survives a
 * prebuild, because `ios/` is gitignored and regenerated.
 *
 * Everything below is `AppFunctionality` and nothing is tracking, which is the
 * honest answer: Swift ships no analytics SDK, no ad SDK and no IDFA — see
 * `src/lib/analytics.ts`, which is a deliberate no-op. If a crash reporter is
 * ever wired up, Diagnostics must be added here in the SAME change that adds
 * it, not afterwards.
 *
 * The accessed-API reasons stay as Expo generates them (FileTimestamp C617.1,
 * UserDefaults CA92.1, SystemBootTime 35F9.1). `DiskSpace` is deliberately NOT
 * declared here: `expo-file-system` is a transitive dependency that ships its
 * own manifest covering DiskSpace and FileTimestamp, and this app's own code
 * calls no disk-space API.
 */
const collected = (
  type: string,
  purposes: string[] = ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
) => ({
  NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
  NSPrivacyCollectedDataTypeLinked: true,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: purposes,
});

const privacyManifests = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyAccessedAPITypes: [
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
  ],
  NSPrivacyCollectedDataTypes: [
    collected('Name'), // account holder, shown to the courier/driver on a job
    collected('PhoneNumber'), // the login identity itself
    collected('EmailAddress'), // optional at registration
    collected('PhysicalAddress'), // delivery + pickup addresses
    collected('PreciseLocation'), // pickup, dispatch, live tracking
    collected('PhotosorVideos'), // delivery proof, document scans, chat images
    collected('SensitiveInfo'), // government ID documents + verification selfie
    collected('OtherUserContent'), // chat messages, review comments
    collected('CustomerSupport'), // support conversations
    collected('UserID'),
    collected('DeviceID'), // push token
    collected('PurchaseHistory'), // order and trip history
  ],
};
/** The brand ground. Splash and the Android adaptive-icon background are the
 *  same maroon on purpose — launching the app should not change colour. */
const brandMaroon = '#803B3B';
const splashBackgroundColor = brandMaroon;
const splashImage = './assets/icon.png';

// Universal Links (iOS) / App Links (Android) for the printed QR short links
// ({APP_PUBLIC_URL}/s/{code}) and storefront links (/store/{slug}). The JS
// router (services/deep-links.ts) already handles both; this is the native
// interception half. The domain must serve
// /.well-known/apple-app-site-association and /.well-known/assetlinks.json —
// apps/web serves both, gated on APPLE_TEAM_ID / ANDROID_CERT_SHA256 env.
const linkDomain = process.env['SWIFT_LINK_DOMAIN'] ?? 'swiftgy.com';

/**
 * THE ANDROID MAPS KEY GATE.
 *
 * Without this key an Android build throws a native host exception the moment
 * any of seven screens mounts its map (see the long note beside `googleMaps`
 * below). It cannot be caught in JS, so the only place to stop it is here,
 * before an artifact exists.
 *
 * A distributable build FAILS. A developer's local build only warns: it is a
 * real cost to them, but blocking someone working on screens that have no map
 * would be the gate doing more harm than the bug.
 */
const androidMapsApiKey = process.env['ANDROID_GOOGLE_MAPS_API_KEY'];
const isDistributableBuild =
  process.env['EAS_BUILD'] === 'true' || process.env['CI'] === 'true';

if (!androidMapsApiKey) {
  const consequence =
    'Android needs ANDROID_GOOGLE_MAPS_API_KEY. Without it react-native-maps ' +
    'throws a NATIVE host exception on first map mount — order tracking, the ' +
    'rider job flow and the PIN handover all die, and no error boundary can ' +
    'catch it. Set it as an EAS secret restricted to this package + SHA-1.';
  if (isDistributableBuild) throw new Error(`[swift] ${consequence}`);
  // eslint-disable-next-line no-console
  console.warn(`[swift] WARNING — ${consequence} Maps screens will crash in this local build.`);
}

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
    // Keep the legacy manifest and the native config plugin on the same asset.
    // A background-only native generation left a stale storyboard image name
    // with no matching asset, producing `Could not load "SplashScreen"`.
    backgroundColor: splashBackgroundColor,
    image: splashImage,
    resizeMode: 'contain',
  },
  ios: {
    bundleIdentifier: 'gy.swift.app',
    supportsTablet: true,
    associatedDomains: [`applinks:${linkDomain}`, `applinks:www.${linkDomain}`],
    privacyManifests,
    infoPlist: {
      CFBundleDisplayName: 'Swift',
      NSLocationWhenInUseUsageDescription: locationWhenInUse,
      NSLocationAlwaysAndWhenInUseUsageDescription: locationAlways,
      // Declared here rather than left to the plugin's boilerplate, which
      // renders the NATIVE target name: "Allow SwiftGY to access your photos".
      NSPhotoLibraryUsageDescription: photosPermission,
      // Export compliance. Swift uses only the OS's own HTTPS plus ATS
      // certificate pinning (config, not a crypto implementation) — no
      // proprietary or non-exempt cryptography. Without this key every upload
      // stalls on the manual question and `eas submit --non-interactive`
      // cannot proceed. [Founder: this is a legal self-classification under
      // the US EAR — worth a five-minute check with counsel.]
      ITSAppUsesNonExemptEncryption: false,
      UIBackgroundModes: ['location', 'remote-notification', 'fetch'],
      // TLS pinning for the production API domain (iOS 14+ system pinning —
      // config only, no runtime library). Pinned to the Let's Encrypt roots'
      // SPKI hashes (ISRG Root X1 + X2, both computed from the published
      // certs), so certificate renewals never invalidate the pin; only a CA
      // change does, which is an app update by design. Dev traffic
      // (localhost) and any non-pinned staging domain are unaffected.
      NSAppTransportSecurity: {
        NSPinnedDomains: {
          'api.swift.gy': {
            NSIncludesSubdomains: true,
            NSPinnedCAIdentities: [
              { 'SPKI-SHA256-BASE64': 'C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=' },
              { 'SPKI-SHA256-BASE64': 'diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=' },
              // [V4] Backup CA — GTS Root R1, computed 2026-08-25 from
              // pki.goog/repo/certs/gtsr1.pem; same rationale and rotation
              // date (2027-07-01) as the Android pin-set.
              { 'SPKI-SHA256-BASE64': 'hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc=' },
            ],
          },
        },
      },
    },
  },
  android: {
    package: 'gy.swift.app',
    // Android adaptive icon [LAUNCH-3]. Only `backgroundColor` was set, and it
    // was WHITE behind a maroon brand mark — but it never showed, because with
    // no `foregroundImage` Expo emits no adaptive icon at all and the launcher
    // falls back to masking the legacy square. That is the shrunken-badge look.
    //
    // The foreground cannot be `icon.png`: the mark spans ~87% of that canvas
    // and a circular mask keeps the middle 66%, so both wingtips get cut.
    // `adaptive-icon-foreground.png` is the same artwork scaled to 60% and
    // re-padded in the identical maroon, so the mark clears the safe zone on
    // every mask shape and the seam is invisible.
    //
    // Still open: no `monochromeImage`, so Android 13+ themed icons fall back
    // to this one. That needs the mark exported from the brand SVG as a
    // single-colour silhouette — a design export, not something to fudge here.
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon-foreground.png',
      backgroundColor: brandMaroon,
    },
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [
          { scheme: 'https', host: linkDomain, pathPrefix: '/s' },
          { scheme: 'https', host: `www.${linkDomain}`, pathPrefix: '/s' },
          { scheme: 'https', host: linkDomain, pathPrefix: '/store' },
          { scheme: 'https', host: `www.${linkDomain}`, pathPrefix: '/store' },
        ],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
    // iOS uses Apple Maps (PROVIDER_DEFAULT, no key). Android's
    // react-native-maps is always Google-backed, and without a key it does NOT
    // render a blank map — that is what this comment used to say, and it is
    // wrong in the direction that matters. `MapsInitializer.initialize` throws
    // inside `MapViewManager.createViewInstance`, which surfaces as
    //
    //   FabricUIManager: Exception thrown when executing UIFrameGuarded
    //   BridgelessReact: ReactHost.handleHostException(...)
    //
    // — a NATIVE host exception, not a JS error. No React error boundary can
    // contain it, so there is no runtime defence to write. In debug it is a
    // redbox; a release build has no redbox to absorb it.
    //
    // Seven screens mount a MapView: the customer's DeliveryScreen, the rider's
    // MoverHomeScreen and ActiveJobScreen, PinConfirmScreen, TaxiScreen,
    // CourierScreen and LocationPickerScreen. That is order tracking, the whole
    // rider job flow, and the PIN handover. A keyless Android artifact is not
    // an app with missing maps; it is an app that dies on contact with its own
    // core flows.
    //
    // So the defence is at build time, below. Set ANDROID_GOOGLE_MAPS_API_KEY in
    // the build env (EAS secret / prebuild env, never committed) and restrict
    // the key to this package name + SHA-1.
    ...(androidMapsApiKey ? { config: { googleMaps: { apiKey: androidMapsApiKey } } } : {}),
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'POST_NOTIFICATIONS',
    ],
    // Permissions pulled in transitively for capabilities Swift does not have.
    // Play scrutinises both: RECORD_AUDIO arrives with expo-camera/image-picker
    // even though no audio API is used anywhere (no expo-av, no Audio.Recording,
    // no expo-media-library), and SYSTEM_ALERT_WINDOW is a special permission
    // nothing here asks for. Shipping a permission you cannot justify is a
    // policy finding on its own.
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ],
  },
  plugins: [
    'expo-font',
    [
      'expo-splash-screen',
      {
        backgroundColor: splashBackgroundColor,
        image: splashImage,
        imageWidth: 140,
        resizeMode: 'contain',
      },
    ],
    ['expo-notifications', { color: '#803B3B' }],
    'react-native-maps',
    'expo-image',
    'expo-secure-store',
    'expo-video',
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
        // Swift never records audio. Left at the default, this plugin injects
        // NSMicrophoneUsageDescription and Android RECORD_AUDIO for a
        // capability the app does not have — a purpose string a reviewer can
        // ask about and we could not justify.
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission,
        cameraPermission,
        microphonePermission: false,
      },
    ],
    // Android half of the api.swift.gy TLS pinning (iOS half: NSPinnedDomains
    // in infoPlist above).
    './plugins/withTlsPinning.js',
  ],
  extra: {
    ...(process.env['EAS_PROJECT_ID'] ? { eas: { projectId: process.env['EAS_PROJECT_ID'] } } : {}),
  },
};

export default config;
