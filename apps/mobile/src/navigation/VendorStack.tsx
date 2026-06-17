import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text, Heading, Button } from '../components/ui';
import { useAuthStore } from '../stores/authStore';

const Stack = createNativeStackNavigator();

// Placeholder until the vendor app (onboarding + incoming orders + menu) lands.
function VendorHome() {
  const { logout } = useAuthStore();
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-1 items-center justify-center px-2xl">
        <Text className="text-5xl">🏪</Text>
        <Heading size="lg" className="mt-md text-center">
          Your vendor account is set up
        </Heading>
        <Text className="mt-xs text-center text-text-secondary">
          Business onboarding, incoming orders and menu management arrive in the next update.
        </Text>
        <Button label="Log out" variant="outline" className="mt-xl px-2xl" onPress={logout} />
      </View>
    </SafeAreaView>
  );
}

export function VendorStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VendorHome" component={VendorHome} />
    </Stack.Navigator>
  );
}
