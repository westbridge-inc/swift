import { useEffect, useRef, useState } from 'react';
import { View, TextInput, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading, PressableScale, StepProgress } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';

export function OtpVerificationScreen({ route, navigation }: any) {
  const { phone } = route.params;
  const [otp, setOtp] = useState('');
  const [error, setError] = useState(false);
  const [seconds, setSeconds] = useState(60);
  const { setAuth } = useAuthStore();
  const inputRef = useRef<TextInput>(null);

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

  const onChange = (t: string) => {
    const digits = t.replace(/[^0-9]/g, '').slice(0, 6);
    setOtp(digits);
    setError(false);
    if (digits.length === 6) handleVerify(digits);
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-row items-center px-lg pt-md">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={12} className="mr-md">
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <View className="flex-1">
          <StepProgress step={2} total={4} />
        </View>
      </View>

      <View className="flex-1 px-lg pt-3xl">
        <View className="items-center">
          <SwiftMark size={48} />
          <Heading size="xl" className="mt-md text-center">Verify your number</Heading>
          <Text className="mt-xs text-center text-text-secondary">
            Enter the 6-digit code sent to{'\n'}
            <Text className="font-semibold text-text-primary">{phone}</Text>
          </Text>
          <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={6}>
            <Text className="mt-sm text-center text-sm font-semibold text-brand-600">Wrong number? Change it</Text>
          </PressableScale>
        </View>

        {/* Six digit boxes — a hidden input captures the code */}
        <Pressable onPress={() => inputRef.current?.focus()} className="mt-2xl">
          <View className="flex-row justify-center" style={{ gap: 8 }}>
            {Array.from({ length: 6 }).map((_, i) => {
              const active = otp.length === i;
              const filled = i < otp.length;
              return (
                <View
                  key={i}
                  className={
                    active
                      ? 'h-14 w-12 items-center justify-center rounded-2xl border-2 border-brand-500 bg-surface-base'
                      : filled
                        ? 'h-14 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-surface-base'
                        : 'h-14 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-surface-subtle'
                  }
                >
                  <Text className="font-display text-2xl font-extrabold text-text-primary">{otp[i] ?? ''}</Text>
                </View>
              );
            })}
          </View>
          <TextInput
            ref={inputRef}
            value={otp}
            onChangeText={onChange}
            keyboardType="number-pad"
            maxLength={6}
            autoFocus
            caretHidden
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
          />
        </Pressable>

        {error ? <Text className="mt-md text-center text-sm text-error">Invalid or expired code. Try again.</Text> : null}
        {seconds > 0 ? (
          <Text className="mt-xl text-center text-sm text-text-muted">Resend code in {seconds}s</Text>
        ) : (
          <PressableScale onPress={resend} hitSlop={8}>
            <Text className="mt-xl text-center text-sm font-semibold text-brand-600">Resend code</Text>
          </PressableScale>
        )}
      </View>
    </SafeAreaView>
  );
}
