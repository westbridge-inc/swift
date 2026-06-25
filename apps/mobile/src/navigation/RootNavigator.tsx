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
import { getAppVariant, partnerStackKey } from '../lib/appVariant';

const Stack = createNativeStackNavigator();

// Two store apps are built from this one codebase (see lib/appVariant):
//   customer ("Swift")          → the consumer super-app
//   partner  ("Swift Partner")  → movers + vendors, role-routed by activeRole
// The variant is fixed at build time; activeRole only routes *within* the partner app.
function mainForVariant(activeRole?: string) {
  if (getAppVariant() === 'customer') return CustomerStack;
  switch (partnerStackKey(activeRole)) {
    case 'mover':
      return MoverStack;
    case 'vendor':
      return VendorStack;
    default:
      return RolePickerScreen; // signed in but not yet a mover/vendor → become one
  }
}

export function RootNavigator() {
  const { isAuthenticated, wantsAuth, user, countryCode } = useAuthStore();
  const Main = mainForVariant(user?.activeRole as string | undefined);

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
