/** @jsxImportSource react */
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { authApi, API_URL } from '../../services/api';
import { openPayLink } from '../../lib/payLink';
import { useAuthStore } from '../../stores/authStore';
import { SwiftMark } from '../../components/SwiftLogo';
import { BrandCheckbox, LabeledInput, PillButton, Screen, T } from '../../kit';

// Kit "Register" (frame 7) on the real signup contract: the phone arrived
// verified from the OTP step; name (+ optional email) completes the account.
export function RegisterScreen() {
  const route = useRoute<any>();
  const phone: string = route.params?.phone ?? '';
  const { setAuth, intent, countryCode } = useAuthStore();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);

  const role = intent === 'mover' ? 'MOVER' : intent === 'vendor' ? 'VENDOR' : 'CUSTOMER';

  const register = useMutation({
    mutationFn: () =>
      authApi.register({
        phone,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        role,
        ...(countryCode ? { countryCode } : {}),
        acceptTerms: agreed, // recorded server-side w/ the legal version [D9-03]
      }),
    onSuccess: (res) => {
      const data = res.data?.data;
      if (data?.user && data?.tokens) {
        setAuth(data.user, data.tokens.accessToken, data.tokens.refreshToken);
      }
    },
  });

  const err = register.isError
    ? ((register.error as any)?.response?.data?.error?.message ?? 'Registration failed. Try again.')
    : undefined;
  const valid = firstName.trim().length >= 2 && lastName.trim().length >= 2 && agreed;

  return (
    <Screen style={{ backgroundColor: color.surface.base }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: space['2xl'], paddingTop: space['2xl'] }}
          keyboardShouldPersistTaps="handled"
        >
          <SwiftMark size={56} />

          <T variant="title" style={{ marginTop: space['2xl'] }}>
            Create your new account
          </T>
          <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
            You’re signing up with <T weight="semibold">{phone}</T>
          </T>
          {role !== 'CUSTOMER' ? (
            // Make the earner "full sign-up" honest: account first, then the
            // vehicle/business + documents step that actually lets them earn.
            <T variant="body" tone="muted" style={{ marginTop: space.xs }}>
              Next, you’ll add {role === 'VENDOR' ? 'your business details and documents' : 'your vehicle and documents'} to finish.
            </T>
          ) : null}

          <View style={{ gap: space.xl, marginTop: space['2xl'] }}>
            <LabeledInput
              label="First Name"
              icon="user"
              placeholder="First name"
              value={firstName}
              onChangeText={setFirstName}
              autoFocus
            />
            <LabeledInput
              label="Last Name"
              icon="user"
              placeholder="Last name"
              value={lastName}
              onChangeText={setLastName}
            />
            <LabeledInput
              label="Email Address (optional)"
              icon="mail"
              placeholder="Enter email"
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
              error={err}
            />
          </View>

          <Pressable
            onPress={() => setAgreed((a) => !a)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xl }}
          >
            <BrandCheckbox checked={agreed} onToggle={() => setAgreed((a) => !a)} />
            <T variant="label" tone="muted" style={{ flex: 1 }}>
              I agree with the{' '}
              <T variant="label" weight="semibold" tone="brand" onPress={() => openPayLink(`${API_URL}/legal/terms`)}>
                Terms of Service
              </T>{' '}
              and{' '}
              <T variant="label" weight="semibold" tone="brand" onPress={() => openPayLink(`${API_URL}/legal/privacy`)}>
                Privacy Policy
              </T>
            </T>
          </Pressable>

          <View style={{ flex: 1 }} />
          <PillButton
            label="Register"
            onPress={() => register.mutate()}
            disabled={!valid}
            loading={register.isPending}
            style={{ marginTop: space['2xl'], marginBottom: space['2xl'] }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
