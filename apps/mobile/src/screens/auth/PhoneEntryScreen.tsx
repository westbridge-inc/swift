/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { flagEmoji } from '../../lib/flags';
import { phoneExample, phoneLenState, clampPhone } from '../../lib/phone';
import { SwiftMark } from '../../components/SwiftLogo';
import { LabeledInput, PillButton, Screen, T } from '../../kit';

// Kit "Login" (frame 5) reshaped for Swift's real auth: phone → OTP. No
// passwords, no social sign-in — the backend has neither.
export function PhoneEntryScreen() {
  const navigation = useNavigation<any>();
  const { dialCode, countryCode, intent, moverPreset, cancelAuth, setIntent } = useAuthStore();
  const [digits, setDigits] = useState('');

  // Length is validated per-country by libphonenumber (handles fixed, variable
  // and long numbers — not just Guyana's 7). Typing is clamped so you can't
  // exceed your country's number; the example placeholder matches the country.
  const onChangeDigits = (t: string) => setDigits(clampPhone(dialCode, t));
  // Changing country can shorten the max — re-clamp what's already typed.
  useEffect(() => setDigits((d) => clampPhone(dialCode, d)), [dialCode]);

  const fullPhone = `${dialCode ?? '+592'}${digits}`;
  const valid = phoneLenState(dialCode, digits) === 'ok';

  // Earners (rider/taxi/seller) reach this screen to SIGN UP, not sign in —
  // frame it that way with their role, instead of a generic "Sign in" that
  // reads like a returning-user login. Customers (guest → checkout) can be
  // new or returning, so they get the honest "sign in or sign up".
  const earner = intent === 'mover' || intent === 'vendor';
  const earnerLabel = intent === 'vendor' ? 'a business' : moverPreset === 'taxi' ? 'a taxi driver' : 'a rider';
  const heading = earner ? 'Create your account' : 'Sign in or sign up';
  const subheading = earner
    ? `Sign up as ${earnerLabel} — we’ll text a one-time code to verify your number.`
    : 'We’ll text you a one-time code — no passwords here.';

  const send = useMutation({
    mutationFn: () => authApi.sendOtp(fullPhone),
    onSuccess: () => navigation.navigate('OtpVerification', { phone: fullPhone }),
  });

  const err = send.isError
    ? ((send.error as any)?.response?.data?.error?.message ?? 'Could not send the code. Try again.')
    : undefined;

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
              placeholder={phoneExample(countryCode)}
              keyboardType="phone-pad"
              maxLength={15}
              value={digits}
              onChangeText={onChangeDigits}
              error={err}
              autoFocus
              right={
                <Pressable
                  testID="auth-country-picker"
                  accessibilityRole="button"
                  accessibilityLabel={`Change country calling code. Current code ${dialCode ?? '+592'}`}
                  onPress={() => navigation.navigate('CountryPicker')}
                  hitSlop={8}
                >
                  {({ pressed }) => (
                    <View
                      style={[
                        {
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingHorizontal: space.md,
                          paddingVertical: 6,
                          borderRadius: 9999,
                          backgroundColor: color.brand[50],
                        },
                        { opacity: pressed ? 0.7 : 1 },
                      ]}
                    >
                      <T variant="label">{flagEmoji(countryCode)}</T>
                      <T variant="label" weight="semibold" tone="deep">
                        {dialCode ?? '+592'}
                      </T>
                      {/* Caret makes it obvious the country is tappable to change */}
                      <Feather name="chevron-down" size={14} color={color.brand[500]} />
                    </View>
                  )}
                </Pressable>
              }
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change country"
              onPress={() => navigation.navigate('CountryPicker')}
              hitSlop={6}
            >
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                Wrong country? <T variant="caption" weight="semibold" tone="brand">Change country</T>
              </T>
            </Pressable>
          </View>

          <View style={{ flex: 1 }} />

          <View style={{ gap: space.md, paddingBottom: space['2xl'] }}>
            <PillButton
              testID="auth-send-code"
              label="Send Code"
              onPress={() => send.mutate()}
              disabled={!valid}
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
