/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { flagEmoji } from '../../lib/flags';
import { phoneExample, phoneLenState, clampPhone } from '../../lib/phone';
import { formatResendWait, otpCooldownOf } from '../../lib/otpCooldown';
import { useCountdown } from '../../hooks/useCountdown';
import { SwiftMark } from '../../components/SwiftLogo';
import { LabeledInput, PillButton, Screen, T } from '../../kit';
import { DEFAULT_COUNTRY } from '../../lib/markets';

// Kit "Login" (frame 5) reshaped for Swift's real auth: phone → OTP. No
// passwords, no social sign-in — the backend has neither.
export function PhoneEntryScreen() {
  const navigation = useNavigation<any>();
  const { intent, cancelAuth, setCountry, setIntent } = useAuthStore();
  const [digits, setDigits] = useState('');

  // V1 is Guyana-only. Repair any stale pre-launch persisted market and keep
  // validation, display and the submitted E.164 number on the same authority.
  useEffect(() => {
    setCountry(DEFAULT_COUNTRY);
    setDigits((d) => clampPhone(DEFAULT_COUNTRY.dialCode, d));
  }, [setCountry]);
  const onChangeDigits = (t: string) => setDigits(clampPhone(DEFAULT_COUNTRY.dialCode, t));

  const fullPhone = `${DEFAULT_COUNTRY.dialCode}${digits}`;
  const valid = phoneLenState(DEFAULT_COUNTRY.dialCode, digits) === 'ok';

  // Earners (rider/taxi/seller) reach this screen to SIGN UP, not sign in —
  // frame it that way with their role, instead of a generic "Sign in" that
  // reads like a returning-user login. Customers (guest → checkout) can be
  // new or returning, so they get the honest "sign in or sign up".
  const earner = intent === 'mover' || intent === 'vendor';
  const earnerLabel = intent === 'vendor' ? 'a business' : 'a Swift driver';
  const heading = earner ? 'Create your account' : 'Sign in or sign up';
  const subheading = earner
    ? `Sign up as ${earnerLabel} — we’ll text a one-time code to verify your number.`
    : 'We’ll text you a one-time code — no passwords here.';

  // A resend inside the number's window is refused with the time left and
  // whether the code sent moments ago is out. That is not a wrong number: the
  // field stays clean, the wait counts down, and a code already sent can be
  // entered on the existing verify step.
  const [cooldown, setCooldown] = useState<{ phone: string; codeAlreadySent: boolean } | null>(null);
  const resendWait = useCountdown();

  const send = useMutation({
    mutationFn: (phone: string) => authApi.sendOtp(phone),
    // Each attempt is judged afresh: an older window never outlives a newer answer.
    onMutate: () => setCooldown(null),
    onSuccess: (_res, phone) => navigation.navigate('OtpVerification', { phone }),
    onError: (error, phone) => {
      const refusal = otpCooldownOf(error);
      if (!refusal) return;
      setCooldown({ phone, codeAlreadySent: refusal.codeAlreadySent });
      resendWait.start(refusal.retryAfterSeconds);
    },
  });

  const err = send.isError && !otpCooldownOf(send.error)
    ? ((send.error as any)?.response?.data?.error?.message ?? 'Could not send the code. Try again.')
    : undefined;
  // The window belongs to the number it was reported for; editing the number
  // leaves it behind.
  const waiting = cooldown?.phone === fullPhone ? cooldown : null;
  const locked = !!waiting && resendWait.secondsLeft > 0;
  const wait = formatResendWait(resendWait.secondsLeft);

  return (
    <Screen style={{ backgroundColor: color.surface.base }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: space['2xl'], paddingTop: space['2xl'] }}
          keyboardShouldPersistTaps="handled"
        >
          <SwiftMark size={56} />

          <T variant="title" style={{ marginTop: space['4xl'] }}>
            {heading}
          </T>
          <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
            {subheading}
          </T>

          <View style={{ marginTop: space['3xl'] }}>
            <LabeledInput
              testID="auth-phone-input"
              accessibilityLabel="Phone number"
              accessibilityHint="Enter your phone number without the country calling code"
              label="Phone Number"
              icon="phone"
              placeholder={phoneExample(DEFAULT_COUNTRY.code)}
              keyboardType="phone-pad"
              maxLength={15}
              value={digits}
              onChangeText={onChangeDigits}
              error={err}
              autoFocus
              right={
                <View
                  accessible
                  accessibilityLabel="Guyana calling code +592"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: space.md,
                    paddingVertical: 6,
                    borderRadius: 9999,
                    backgroundColor: color.brand[50],
                  }}
                >
                  <T variant="label">{flagEmoji(DEFAULT_COUNTRY.code)}</T>
                  <T variant="label" weight="semibold" tone="deep">+592</T>
                </View>
              }
            />
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              Swift is currently available in Guyana.
            </T>
            {waiting && (waiting.codeAlreadySent || locked) ? (
              // Calm, not an error. No live region: the countdown ticks
              // every second and must not be re-announced each time.
              <View
                testID="auth-resend-wait"
                accessible
                style={{
                  marginTop: space.lg,
                  padding: space.lg,
                  gap: space.xs,
                  borderRadius: radius.lg,
                  backgroundColor: color.surface.sunken,
                }}
              >
                <T variant="label" weight="semibold">
                  {waiting.codeAlreadySent ? 'Code already sent' : 'Just a moment'}
                </T>
                <T variant="caption" tone="muted">
                  {waiting.codeAlreadySent
                    ? `We texted a code to ${fullPhone} moments ago. Enter that code, or request a new one${locked ? ` in ${wait}` : ''}.`
                    : `A code was just requested for ${fullPhone}. You can request a new one in ${wait}.`}
                </T>
              </View>
            ) : null}
          </View>

          <View style={{ flex: 1 }} />

          <View style={{ gap: space.md, paddingBottom: space['2xl'] }}>
            {waiting?.codeAlreadySent ? (
              <PillButton
                testID="auth-enter-code"
                label="Enter Code"
                onPress={() => navigation.navigate('OtpVerification', { phone: fullPhone, resendInSeconds: resendWait.secondsLeft })}
              />
            ) : null}
            <PillButton
              testID="auth-send-code"
              label={waiting?.codeAlreadySent ? 'Resend Code' : 'Send Code'}
              variant={waiting?.codeAlreadySent ? 'outline' : 'primary'}
              onPress={() => send.mutate(fullPhone)}
              disabled={!valid || locked}
              loading={send.isPending}
            />
            {intent === 'customer' ? (
              <PillButton testID="auth-browse-guest" label="Browse as Guest" variant="soft" onPress={cancelAuth} />
            ) : (
              // [SPS-F-0024] No surface is a one-way door. Advertiser, driver,
              // and business sign-ups land here as the ROOT screen (no back
              // stack), and the entry gate keeps returning 'auth' while their
              // intent is set — so leaving requires clearing BOTH the auth ask
              // and the intent. Customers keep "Browse as Guest" above; the
              // trio's sign-in-first path (intent null) also lands here and
              // returns to the welcome trio the same way.
              <PillButton
                testID="auth-back-to-welcome"
                label="Back to the welcome screen"
                variant="soft"
                onPress={() => {
                  cancelAuth();
                  setIntent(null);
                }}
              />
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
