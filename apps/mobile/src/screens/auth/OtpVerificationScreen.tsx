import { useState } from 'react';
import { View, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading } from '../../components/ui';

export function OtpVerificationScreen({ route, navigation }: any) {
  const { phone } = route.params;
  const [otp, setOtp] = useState('');
  const [error, setError] = useState(false);
  const { setAuth } = useAuthStore();

  const handleVerify = async (code: string) => {
    if (code.length !== 6) return;
    try {
      const { data } = await authApi.verifyOtp(phone, code);
      if (data.data.isNewUser) {
        navigation.navigate('RolePicker', { phone });
      } else {
        setAuth(data.data.user, data.data.tokens.accessToken, data.data.tokens.refreshToken);
      }
    } catch {
      setError(true);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-1 justify-center px-lg">
        <Heading size="xl" className="text-center">
          Enter the code
        </Heading>
        <Text className="mt-xs text-center text-text-secondary">Sent to {phone}</Text>
        <TextInput
          value={otp}
          onChangeText={(t) => {
            setOtp(t);
            setError(false);
            if (t.length === 6) handleVerify(t);
          }}
          placeholder="000000"
          placeholderTextColor={color.border.strong}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
          textAlign="center"
          className="mt-xl rounded-lg border border-border-subtle bg-surface-subtle py-lg font-display text-3xl font-bold text-text-primary"
        />
        {error ? <Text className="mt-sm text-center text-sm text-error">Invalid or expired code. Try again.</Text> : null}
        <Text className="mt-lg text-center text-sm text-text-muted">Resend code in 60s</Text>
      </View>
    </SafeAreaView>
  );
}
