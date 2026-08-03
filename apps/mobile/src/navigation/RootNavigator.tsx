/** @jsxImportSource react */
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { useMoverPreview } from '../stores/moverPreview';
import { useVendorPreview } from '../stores/vendorPreview';
import { useCustomerCountry } from '../hooks/useCustomerCountry';
import { registerDeviceForPush } from '../services/push';
import { OnboardingScreen } from '../modules/onboarding/OnboardingScreen';
import { CountryPickerScreen } from '../screens/auth/CountryPickerScreen';
import { RolePickerScreen } from '../screens/auth/RolePickerScreen';
import { SelfieCaptureScreen } from '../screens/auth/SelfieCaptureScreen';
import { AuthStack } from './AuthStack';
import { CustomerStack } from './CustomerStack';
import { MoverStack } from '../modules/mover/MoverStack';
import { VendorStack } from '../modules/vendor/VendorStack';
import { AdvertiserStack } from '../modules/advertiser/AdvertiserStack';
import { navigationRef } from './navigationRef';
import { installNotificationTapRouter, flushPendingNavigation } from '../services/notification-router';
import { installDeepLinkHandler, flushPendingDeepLink } from '../services/deep-links';
import { ensureFirstLaunchClaim, flushAttributedDestination } from '../services/attribution';

const Stack = createNativeStackNavigator();

// One "Swift" app. The entry "How will you use Swift?" screen sets `intent`,
// which picks the experience:
//   customer → consumer super-app (browse as a guest; sign in at checkout)
//   mover    → driver/rider earner app (must sign in + onboard)
//   vendor   → store/restaurant dashboard (must sign in + onboard)
function mainForIntent(intent?: string | null) {
  switch (intent) {
    case 'mover':
      return MoverStack;
    case 'vendor':
      return VendorStack;
    case 'advertiser':
      return AdvertiserStack;
    default:
      return CustomerStack;
  }
}

export function RootNavigator() {
  const { isAuthenticated, wantsAuth, intent, countryCode, user } = useAuthStore();
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  // Customers skip the country picker — their market is seeded + resolved from
  // location instead (spec: pick role → straight to browsing).
  useCustomerCountry();

  // Push registration follows the session (config-gated no-op until the EAS
  // project id ships — see services/push.ts).
  React.useEffect(() => {
    if (isAuthenticated) void registerDeviceForPush();
  }, [isAuthenticated]);

  // The tap-router [first-open 2.4]: every notification tap lands on its
  // exact screen — cold starts flush via onReady below.
  React.useEffect(() => installNotificationTapRouter(), []);

  // QR deep links (/store/{slug}, /s/{code}) + the one-time install claim
  // [qr spec Part 6]: same queue-and-flush contract as the tap-router.
  React.useEffect(() => {
    ensureFirstLaunchClaim();
    return installDeepLinkHandler();
  }, []);

  // Earners (mover/vendor) and advertisers must be signed in before their
  // stack. Customers browse freely and only authenticate when an action
  // (checkout) asks via promptLogin() → wantsAuth.
  const earner = intent === 'mover' || intent === 'vendor' || intent === 'advertiser';
  // PREVIEW (earner R3 / vendor R4): a prospective driver ("Preview the driver
  // app") or business ("Preview a business") reaches the REAL stack WITHOUT a
  // country, sign-in, or selfie — read-only sample data. The vendor SAMPLE
  // preview is `previewType != null` (a set type), NOT the legacy pending-vendor
  // peek (previewType null), which stays signed-in.
  const moverPreview = useMoverPreview((s) => s.preview);
  const vendorSamplePreview = useVendorPreview((s) => s.previewType) != null;
  const anyPreview = moverPreview || vendorSamplePreview;
  const needsAuth = earner ? (!isAuthenticated && !anyPreview) : wantsAuth && !isAuthenticated;
  // Mandatory signup selfie (master plan §3): every signed-in account must
  // carry a camera-captured profile photo before using the app. Guests browse
  // untouched; the API enforces the same rule on orders/rides/go-online.
  const needsSelfie = isAuthenticated && !!user && !user.selfieCapturedAt;
  const Main = mainForIntent(intent);

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        flushPendingNavigation();
        flushPendingDeepLink();
        flushAttributedDestination();
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!hasOnboarded ? (
          // First run only: kit onboarding slides, then never again.
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        ) : !intent ? (
          // Role FIRST: "How will you use Swift?" decides the whole path — a
          // customer then just picks a country and browses (sign-in waits for
          // checkout); a mover/vendor picks a country then does full sign-up.
          <Stack.Screen name="RolePicker" component={RolePickerScreen} />
        ) : earner && !countryCode && !anyPreview ? (
          // Only earners pick a country here (it drives their signup + pricing);
          // customers are seeded/resolved by useCustomerCountry and go straight
          // to browsing.
          <Stack.Screen name="Country" component={CountryPickerScreen} />
        ) : needsAuth ? (
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : needsSelfie ? (
          <Stack.Screen name="Selfie" component={SelfieCaptureScreen} />
        ) : (
          <Stack.Screen name="Main" component={Main} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
