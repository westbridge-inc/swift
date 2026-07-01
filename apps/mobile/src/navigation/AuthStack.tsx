import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { PhoneEntryScreen } from '../screens/auth/PhoneEntryScreen';
import { OtpVerificationScreen } from '../screens/auth/OtpVerificationScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';

const Stack = createNativeStackNavigator();

export function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
      <Stack.Screen name="OtpVerification" component={OtpVerificationScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
    </Stack.Navigator>
  );
}
