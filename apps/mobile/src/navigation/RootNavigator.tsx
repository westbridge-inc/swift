import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { AuthStack } from './AuthStack';
import { CustomerStack } from './CustomerStack';
import { RiderStack } from './RiderStack';
import { DriverStack } from './DriverStack';
import { VendorStack } from './VendorStack';
import { UserRole } from '@swift/types';

const Stack = createNativeStackNavigator();

function getRoleStack(role: UserRole) {
  switch (role) {
    case UserRole.CUSTOMER:
      return CustomerStack;
    case UserRole.RIDER:
      return RiderStack;
    case UserRole.DRIVER:
      return DriverStack;
    case UserRole.VENDOR_OWNER:
      return VendorStack;
    default:
      return CustomerStack;
  }
}

export function RootNavigator() {
  const { isAuthenticated, user } = useAuthStore();

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuthenticated ? (
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : (
          <Stack.Screen
            name="Main"
            component={getRoleStack(user?.role as UserRole)}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
