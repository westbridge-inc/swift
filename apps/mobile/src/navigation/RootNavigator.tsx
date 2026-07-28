/** @jsxImportSource react */
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { useMoverPreview } from '../stores/moverPreview';
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

  // Earners (mover/vendor) must be signed in before their stack. Customers
  // browse freely and only authenticate when an action (checkout) asks via
  // promptLogin() → wantsAuth.
  const earner = intent === 'mover' || intent === 'vendor';
  // Earner PREVIEW (R3): a prospective driver taps "Preview the driver app" on
  // the role picker → intent='mover' + preview on. Preview must reach the REAL
  // MoverStack WITHOUT a country, sign-in, or selfie — it's read-only sample data.
  const moverPreview = useMoverPreview((s) => s.preview);
  const needsAuth = earner ? (!isAuthenticated && !moverPreview) : wantsAuth && !isAuthenticated;
  // Mandatory signup selfie (master plan §3): every signed-in account must
  // carry a camera-captured profile photo before using the app. Guests browse
  // untouched; the API enforces the same rule on orders/rides/go-online.
  const needsSelfie = isAuthenticated && !!user && !user.selfieCapturedAt;
  const Main = mainForIntent(intent);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!hasOnboarded ? (
          // First run only: kit onboarding slides, then never again.
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        ) : !intent ? (
          // Role FIRST: "How will you use Swift?" decides the whole path — a
          // customer then just picks a country and browses (sign-in waits for
          // checkout); a mover/vendor picks a country then does full sign-up.
          <Stack.Screen name="RolePicker" component={RolePickerScreen} />
        ) : earner && !countryCode && !moverPreview ? (
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
