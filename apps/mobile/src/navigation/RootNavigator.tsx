import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { CountryPickerScreen } from '../screens/auth/CountryPickerScreen';
import { AuthStack } from './AuthStack';
import { CustomerStack } from './CustomerStack';
import { MoverStack } from '../modules/mover/MoverStack';
import { VendorStack } from '../modules/vendor/VendorStack';

const Stack = createNativeStackNavigator();

// One app, role-routed. Entry: pick country → sign up → land in the active role's stack.
function stackForRole(activeRole?: string) {
  switch (activeRole) {
    case 'MOVER':
    case 'RIDER':
    case 'DRIVER':
      return MoverStack;
    case 'VENDOR_OWNER':
      return VendorStack;
    default:
      return CustomerStack;
  }
}

export function RootNavigator() {
  const { isAuthenticated, wantsAuth, user, countryCode } = useAuthStore();
  const Main = stackForRole(user?.activeRole as string | undefined);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!countryCode ? (
          <Stack.Screen name="Country" component={CountryPickerScreen} />
        ) : !isAuthenticated && wantsAuth ? (
          // Guests browse in Main; the auth flow shows only when an action asks
          // for it (promptLogin), then returns to browsing or the role stack.
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : (
          <Stack.Screen name="Main" component={Main} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
