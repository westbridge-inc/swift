import { useState } from 'react';
import { View, TextInput, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading, Button, PressableScale, StepProgress } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';

export function PhoneEntryScreen({ navigation }: any) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const dialCode = useAuthStore((s) => s.dialCode) ?? '+592';

  const handleSendOtp = async () => {
    setLoading(true);
    setError(false);
    try {
      const full = `${dialCode}${phone}`;
      await authApi.sendOtp(full);
      navigation.navigate('OtpVerification', { phone: full });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-row items-center px-lg pt-md">
        <PressableScale onPress={() => useAuthStore.getState().cancelAuth()} hitSlop={10} className="mr-md">
          <Feather name="x" size={24} color={color.text.primary} />
        </PressableScale>
        <View className="flex-1">
          <StepProgress step={1} total={4} />
        </View>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View className="flex-1 px-lg pt-3xl">
          <View className="items-center">
            <SwiftMark size={56} />
            <Heading size="3xl" className="mt-sm text-center text-text-primary">
              Swift
            </Heading>
          </View>
          <Heading size="xl" className="mt-3xl text-center">
            Enter your phone number
          </Heading>
          <Text className="mt-xs text-center text-text-secondary">We&apos;ll text you a verification code.</Text>
          <View className="mt-xl flex-row" style={{ gap: 12 }}>
            <PressableScale
              onPress={() => Alert.alert('Country', `Calling code ${dialCode}. Your country is chosen during onboarding.`)}
              className="flex-row items-center justify-center rounded-lg border border-border-subtle bg-surface-subtle px-md"
            >
              <Text className="text-base font-semibold">{dialCode}</Text>
              <Feather name="chevron-down" size={15} color={color.text.muted} style={{ marginLeft: 4 }} />
            </PressableScale>
            <TextInput
              value={phone}
              onChangeText={(t) => {
                setPhone(t);
                setError(false);
              }}
              placeholder="Phone number"
              placeholderTextColor={color.text.muted}
              keyboardType="phone-pad"
              autoFocus
              className="flex-1 rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-lg text-text-primary"
            />
          </View>
          {error ? <Text className="mt-sm text-center text-sm text-error">Couldn&apos;t send the code. Try again.</Text> : null}
        </View>
        <View className="px-lg pb-md">
          <Button label="Continue" loading={loading} disabled={!phone} onPress={handleSendOtp} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
