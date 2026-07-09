import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
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

  // Earners (mover/vendor) must be signed in before their stack. Customers
  // browse freely and only authenticate when an action (checkout) asks via
  // promptLogin() → wantsAuth.
  const earner = intent === 'mover' || intent === 'vendor';
  const needsAuth = earner ? !isAuthenticated : wantsAuth && !isAuthenticated;
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
        ) : !countryCode ? (
          <Stack.Screen name="Country" component={CountryPickerScreen} />
        ) : !intent ? (
          <Stack.Screen name="RolePicker" component={RolePickerScreen} />
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
