import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { CountryPickerScreen } from '../screens/auth/CountryPickerScreen';
import { RolePickerScreen } from '../screens/auth/RolePickerScreen';
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
  const { isAuthenticated, wantsAuth, intent, countryCode } = useAuthStore();

  // Earners (mover/vendor) must be signed in before their stack. Customers
  // browse freely and only authenticate when an action (checkout) asks via
  // promptLogin() → wantsAuth.
  const earner = intent === 'mover' || intent === 'vendor';
  const needsAuth = earner ? !isAuthenticated : wantsAuth && !isAuthenticated;
  const Main = mainForIntent(intent);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!countryCode ? (
          <Stack.Screen name="Country" component={CountryPickerScreen} />
        ) : !intent ? (
          <Stack.Screen name="RolePicker" component={RolePickerScreen} />
        ) : needsAuth ? (
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : (
          <Stack.Screen name="Main" component={Main} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
