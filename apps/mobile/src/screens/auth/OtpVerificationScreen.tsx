/** @jsxImportSource react */
import React, { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { formatResendWait, OTP_RESEND_WINDOW_S, otpCooldownOf } from '../../lib/otpCooldown';
import { useCountdown } from '../../hooks/useCountdown';
import { Header, PillButton, Screen, T } from '../../kit';

const CODE_LEN = 6;

// Composed in the kit's input language (no OTP frame in the kit): six cells
// driven by one hidden input. verify-otp forks: existing user → session;
// new phone → Register.
export function OtpVerificationScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const phone: string = route.params?.phone ?? '';
  // The phone step hands over the time left when it offers a code already
  // sent; otherwise a send just happened and the whole server window is ahead.
  const resendIn: number = route.params?.resendInSeconds ?? OTP_RESEND_WINDOW_S;
  const setAuth = useAuthStore((s) => s.setAuth);

  const [code, setCode] = useState('');
  const cooldown = useCountdown(resendIn);
  // A resend refused inside the window sent nothing new: say so.
  const [resendRefused, setResendRefused] = useState<{ codeAlreadySent: boolean } | null>(null);
  const inputRef = useRef<TextInput>(null);

  const verify = useMutation({
    mutationFn: (c: string) => authApi.verifyOtp(phone, c),
    onSuccess: (res) => {
      const data = res.data?.data;
      if (data?.isNewUser) {
        navigation.navigate('Register', {
          phone,
          registrationProof: typeof data.registrationProof === 'string' ? data.registrationProof : '',
        });
        return;
      }
      if (data?.user && data?.tokens) {
        setAuth(data.user, data.tokens.accessToken, data.tokens.refreshToken);
      }
    },
  });

  const resend = useMutation({
    mutationFn: () => authApi.sendOtp(phone),
    onSuccess: () => {
      setResendRefused(null);
      cooldown.start(OTP_RESEND_WINDOW_S);
    },
    onError: (error) => {
      const refusal = otpCooldownOf(error);
      if (!refusal) return;
      setResendRefused({ codeAlreadySent: refusal.codeAlreadySent });
      cooldown.start(refusal.retryAfterSeconds);
    },
  });

  const onChange = (v: string) => {
    const clean = v.replace(/\D/g, '').slice(0, CODE_LEN);
    setCode(clean);
    if (clean.length === CODE_LEN && !verify.isPending) verify.mutate(clean);
  };

  const err = verify.isError
    ? ((verify.error as any)?.response?.data?.error?.message ?? 'That code didn’t match. Try again.')
    : undefined;

  return (
    <Screen style={{ backgroundColor: color.surface.base }}>
      <Header title="Verify" />
      <View style={{ flex: 1, paddingHorizontal: space['2xl'], paddingTop: space['2xl'] }}>
        <T variant="title">Enter the code.</T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          We sent a 6-digit code to <T weight="semibold">{phone}</T>
        </T>

        {/* Hidden driver input + six visible cells */}
        <Pressable
          testID="otp-code-entry"
          accessibilityRole="button"
          accessibilityLabel="Enter 6-digit verification code"
          accessibilityHint="Open the number pad to enter the code sent to your phone"
          accessibilityValue={{ text: `${code.length} of ${CODE_LEN} digits entered` }}
          onPress={() => inputRef.current?.focus()}
          style={{ marginTop: space['3xl'] }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {Array.from({ length: CODE_LEN }, (_, i) => {
              const filled = i < code.length;
              const active = i === code.length;
              return (
                <View
                  key={i}
                  style={{
                    width: 48,
                    height: 56,
                    borderRadius: radius.lg,
                    borderWidth: 1.5,
                    borderColor: err ? color.error : active || filled ? color.brand[500] : color.border.subtle,
                    backgroundColor: color.surface.base,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <T variant="title">{code[i] ?? ''}</T>
                </View>
              );
            })}
          </View>
        </Pressable>
        <TextInput
          testID="otp-code-input"
          ref={inputRef}
          value={code}
          onChangeText={onChange}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={CODE_LEN}
          autoFocus
          accessible={false}
          style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
        />

        {err ? (
          <T
            variant="label"
            tone="error"
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={{ marginTop: space.lg }}
          >
            {err}
          </T>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space['2xl'] }}>
          <T variant="label" tone="muted">
            Didn’t get it?
          </T>
          {cooldown.secondsLeft > 0 ? (
            <T variant="label" tone="faint" accessibilityLiveRegion="polite">
              Resend in {formatResendWait(cooldown.secondsLeft)}
            </T>
          ) : (
            <Pressable
              testID="otp-resend"
              accessibilityRole="button"
              accessibilityLabel="Resend verification code"
              accessibilityState={{ disabled: resend.isPending, busy: resend.isPending }}
              onPress={() => resend.mutate()}
              hitSlop={8}
              disabled={resend.isPending}
            >
              <View style={{ paddingVertical: 4 }}>
                <T variant="label" weight="semibold" tone="brand">
                  {resend.isPending ? 'Sending…' : 'Resend code'}
                </T>
              </View>
            </Pressable>
          )}
        </View>
        {resendRefused && cooldown.secondsLeft > 0 ? (
          <T testID="otp-resend-wait" variant="label" tone="muted" style={{ marginTop: space.sm }}>
            {resendRefused.codeAlreadySent
              ? 'No new code yet: enter the one we texted you moments ago.'
              : 'A code was just requested for this number. You can resend when the timer ends.'}
          </T>
        ) : null}

        <View style={{ flex: 1 }} />
        <PillButton
          testID="otp-verify"
          label="Verify"
          onPress={() => verify.mutate(code)}
          disabled={code.length < CODE_LEN}
          loading={verify.isPending}
          style={{ marginBottom: space['2xl'] }}
        />
      </View>
    </Screen>
  );
}
