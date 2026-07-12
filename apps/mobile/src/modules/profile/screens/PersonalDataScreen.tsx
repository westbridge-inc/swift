/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { color, space } from '@swift/ui';
import { customerApi } from '../../../services/api';
import { useProfile } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { ErrorState, Header, LabeledInput, LoadingBlock, PillButton, Screen, T } from '../../../kit';

const GUTTER = space['2xl'];

// Kit Personal Data (50): avatar, labeled fields, save. Phone is the account
// key (read-only); the avatar comes from the mandatory signup selfie.
export function PersonalDataScreen() {
  const qc = useQueryClient();
  const profile = useProfile<any>();
  const setUser = useAuthStore((s) => s.setUser);
  const user = useAuthStore((s) => s.user);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  const p = profile.data;
  useEffect(() => {
    if (p) {
      setFirstName(p.firstName ?? '');
      setLastName(p.lastName ?? '');
      setEmail(p.email ?? '');
    }
  }, [p]);

  const save = useMutation({
    mutationFn: () =>
      customerApi.updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
      }),
    onSuccess: (res) => {
      const updated = res.data?.data;
      if (updated && user) setUser({ ...user, firstName: updated.firstName, lastName: updated.lastName });
      qc.invalidateQueries({ queryKey: ['customer', 'profile'] });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    },
  });

  if (profile.isLoading) return <LoadingBlock style={{ backgroundColor: color.surface.subtle }} />;
  if (profile.isError || !p) {
    return (
      <Screen>
        <Header title="Personal Data" />
        <ErrorState onRetry={() => profile.refetch()} />
      </Screen>
    );
  }

  const err = save.isError
    ? ((save.error as any)?.response?.data?.error?.message ?? 'Could not save. Try again.')
    : undefined;

  return (
    <Screen>
      <Header title="Personal Data" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingTop: space.lg, paddingBottom: space['2xl'] }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ alignItems: 'center' }}>
            {p.avatar ? (
              <Image source={{ uri: p.avatar }} style={{ width: 110, height: 110, borderRadius: 55 }} />
            ) : (
              <View
                style={{
                  width: 110,
                  height: 110,
                  borderRadius: 55,
                  backgroundColor: color.brand[50],
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Feather name="user" size={44} color={color.brand[600]} />
              </View>
            )}
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              Profile photo comes from your signup selfie.
            </T>
          </View>

          <View style={{ gap: space.xl, marginTop: space['2xl'] }}>
            <LabeledInput label="First Name" icon="user" value={firstName} onChangeText={setFirstName} />
            <LabeledInput label="Last Name" icon="user" value={lastName} onChangeText={setLastName} />
            <LabeledInput
              label="Email Address"
              icon="mail"
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
              error={err}
            />
            <LabeledInput label="Phone Number" icon="phone" value={p.phone ?? ''} editable={false} />
          </View>

          <View style={{ flex: 1 }} />
          {savedFlash ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: space.md }}>
              <Feather name="check-circle" size={14} color={color.success} />
              <T variant="label" tone="success">
                Saved
              </T>
            </View>
          ) : null}
          <PillButton
            label="Save Changes"
            loading={save.isPending}
            disabled={firstName.trim().length < 2 || lastName.trim().length < 2}
            onPress={() => save.mutate()}
            style={{ marginTop: space.xl }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
