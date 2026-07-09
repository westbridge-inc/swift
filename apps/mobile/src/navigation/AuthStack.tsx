import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CountryPickerScreen } from '../screens/auth/CountryPickerScreen';
import { PhoneEntryScreen } from '../screens/auth/PhoneEntryScreen';
import { OtpVerificationScreen } from '../screens/auth/OtpVerificationScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';

const Stack = createNativeStackNavigator();

// Sign-in flow: phone → OTP → (new account) register. Country change re-enters
// the picker. Layouts follow kit Login/Register; auth stays phone-OTP (no
// passwords / social — the backend has neither).
export function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
      <Stack.Screen name="OtpVerification" component={OtpVerificationScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
      <Stack.Screen name="CountryPicker" component={CountryPickerScreen} />
    </Stack.Navigator>
  );
}
