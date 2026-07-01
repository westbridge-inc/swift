import { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading, Button, PressableScale, StepProgress } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';
import { flagEmoji } from '../../lib/flags';

export function PhoneEntryScreen({ navigation }: any) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const dialCode = useAuthStore((s) => s.dialCode) ?? '+592';
  const countryCode = useAuthStore((s) => s.countryCode);

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
        <PressableScale onPress={() => navigation.goBack()} hitSlop={10} className="mr-md">
          <Feather name="chevron-left" size={24} color={color.text.primary} />
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
            <Text className="mt-xs text-center text-sm text-text-secondary">
              Order, ride, send — at the real price. No fees, ever.
            </Text>
          </View>
          <Heading size="xl" className="mt-3xl text-center">
            Enter your phone number
          </Heading>
          <Text className="mt-xs text-center text-text-secondary">We&apos;ll text you a verification code.</Text>
          <View className="mt-xl flex-row" style={{ gap: 12 }}>
            <PressableScale
              onPress={() => navigation.navigate('CountryPicker')}
              className="flex-row items-center justify-center rounded-2xl border border-border-subtle bg-surface-subtle px-md"
            >
              <Text style={{ fontSize: 18 }}>{flagEmoji(countryCode)}</Text>
              <Text className="ml-1.5 text-base font-semibold">{dialCode}</Text>
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
              className="flex-1 rounded-2xl border border-border-subtle bg-surface-base px-lg py-md font-body text-lg text-text-primary"
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
