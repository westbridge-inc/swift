import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { CountryPickerScreen } from '../screens/auth/CountryPickerScreen';
import { AuthStack } from './AuthStack';
import { CustomerStack } from './CustomerStack';
import { MoverStack } from './MoverStack';
import { VendorStack } from './VendorStack';

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
  const { isAuthenticated, user, countryCode } = useAuthStore();
  const Main = stackForRole(user?.activeRole as string | undefined);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!countryCode ? (
          <Stack.Screen name="Country" component={CountryPickerScreen} />
        ) : !isAuthenticated ? (
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : (
          <Stack.Screen name="Main" component={Main} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
