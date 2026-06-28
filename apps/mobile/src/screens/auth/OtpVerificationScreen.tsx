import { useEffect, useState } from 'react';
import { View, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading, PressableScale, StepProgress } from '../../components/ui';

export function OtpVerificationScreen({ route, navigation }: any) {
  const { phone } = route.params;
  const [otp, setOtp] = useState('');
  const [error, setError] = useState(false);
  const [seconds, setSeconds] = useState(60);
  const { setAuth } = useAuthStore();

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const handleVerify = async (code: string) => {
    if (code.length !== 6) return;
    try {
      const { data } = await authApi.verifyOtp(phone, code);
      if (data.data.isNewUser) {
        // Role is already chosen on the entry screen (intent); go straight to
        // the name step. Defaults to a customer account if somehow unset.
        navigation.navigate('Register', { phone });
      } else {
        setAuth(data.data.user, data.data.tokens.accessToken, data.data.tokens.refreshToken);
      }
    } catch {
      setError(true);
    }
  };

  const resend = async () => {
    if (seconds > 0) return;
    try {
      await authApi.sendOtp(phone);
      setSeconds(60);
      setOtp('');
      setError(false);
    } catch {
      setError(true);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={12}>
          <Feather name="chevron-left" size={26} color={color.text.primary} />
        </PressableScale>
      </View>
      <View className="px-lg">
        <StepProgress step={2} total={4} />
      </View>
      <View className="flex-1 justify-center px-lg">
        <Heading size="xl" className="text-center">
          Enter the code
        </Heading>
        <Text className="mt-xs text-center text-text-secondary">Sent to {phone}</Text>
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={6}>
          <Text className="mt-xs text-center text-sm font-semibold text-brand-600">Wrong number? Change it</Text>
        </PressableScale>
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
        {seconds > 0 ? (
          <Text className="mt-lg text-center text-sm text-text-muted">Resend code in {seconds}s</Text>
        ) : (
          <PressableScale onPress={resend} hitSlop={8}>
            <Text className="mt-lg text-center text-sm font-semibold text-brand-600">Resend code</Text>
          </PressableScale>
        )}
      </View>
    </SafeAreaView>
  );
}
