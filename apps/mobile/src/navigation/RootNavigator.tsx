import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { AuthStack } from './AuthStack';
import { CustomerStack } from './CustomerStack';

const Stack = createNativeStackNavigator();

// Swift consumer app: customers only. Mover/vendor apps are separate surfaces.
export function RootNavigator() {
  const { isAuthenticated } = useAuthStore();

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuthenticated ? (
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : (
          <Stack.Screen name="Main" component={CustomerStack} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
