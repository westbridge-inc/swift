import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { flagEmoji } from '../../lib/flags';
import { SwiftMark } from '../../components/SwiftLogo';
import { LabeledInput, PillButton, Screen, T } from '../../kit';

// Kit "Login" (frame 5) reshaped for Swift's real auth: phone → OTP. No
// passwords, no social sign-in — the backend has neither.
export function PhoneEntryScreen() {
  const navigation = useNavigation<any>();
  const { dialCode, countryCode, intent, cancelAuth } = useAuthStore();
  const [digits, setDigits] = useState('');

  const fullPhone = `${dialCode ?? '+592'}${digits.replace(/\D/g, '')}`;
  const valid = digits.replace(/\D/g, '').length >= 6;

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
            Sign in to Swift.
          </T>
          <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
            We’ll text you a one-time code — no passwords here.
          </T>

          <View style={{ marginTop: space['3xl'] }}>
            <LabeledInput
              label="Phone Number"
              icon="phone"
              placeholder="600 0000"
              keyboardType="phone-pad"
              value={digits}
              onChangeText={setDigits}
              error={err}
              autoFocus
              right={
                <Pressable onPress={() => navigation.navigate('CountryPicker')} hitSlop={8}>
                  {({ pressed }) => (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: space.md,
                        paddingVertical: 6,
                        borderRadius: 9999,
                        backgroundColor: color.brand[50],
                        opacity: pressed ? 0.7 : 1,
                      }}
                    >
                      <T variant="label">{flagEmoji(countryCode)}</T>
                      <T variant="label" weight="semibold" tone="deep">
                        {dialCode ?? '+592'}
                      </T>
                    </View>
                  )}
                </Pressable>
              }
            />
          </View>

          <View style={{ flex: 1 }} />

          <View style={{ gap: space.md, paddingBottom: space['2xl'] }}>
            <PillButton
              label="Send Code"
              onPress={() => send.mutate()}
              disabled={!valid}
              loading={send.isPending}
            />
            {intent === 'customer' ? (
              <PillButton label="Browse as Guest" variant="soft" onPress={cancelAuth} />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
