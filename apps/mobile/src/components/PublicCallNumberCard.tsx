/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, LabeledInput, PillButton, T } from '../kit';

/**
 * Publish a number customers can call BEFORE they order — "do you have this in
 * stock", "can you do this today". Opt-in; clearing it takes the call button
 * down.
 *
 * Sits beside MmgPayLinkCard and is deliberately built to the same pattern,
 * because it is the same promise to the shopkeeper: one field on your own
 * dashboard, you decide, you can undo it.
 *
 * A LANDLINE IS THE POINT. Many shops answer a fixed GTT line rather than a
 * mobile, so the copy names it first and the keyboard does not assume a mobile.
 *
 * This is NOT the account phone. That number stays private and is never shown
 * to a customer; the server keeps them in two different columns for that
 * reason. The caption says so, because a shopkeeper typing here has no other
 * way to know which of their numbers Swift already holds.
 */
/** [REVIEW-F #2220 S3-1] The card's words, shared with the add-a-branch form (the same disclosure wherever the
 *  number is asked for). */
export const PUBLIC_CALL_COPY = {
  title: 'Your call-us number',
  shown: 'Customers see this on your store page and can call before they order. Your landline or your mobile — whichever you actually answer. Leave it empty to hide it.',
  separate: 'This is separate from the number you sign in with, which stays private.',
  placeholder: '+592 225 1234',
} as const;

/**
 * The number field with its disclosure, without a save button: the add-a-branch form sends it with the branch
 * (POST /vendor/stores `publicPhone`), where it is required — a branch goes live only with a number to call.
 */
export function PublicCallNumberField({ value, onChange, required = false }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <MaterialCommunityIcons name="phone-in-talk" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">{required ? 'The number customers can call' : PUBLIC_CALL_COPY.title}</T>
      </View>
      <T variant="caption" tone="muted">
        {required ? 'Customers see this on the branch’s page and can call before they order. Your landline or your mobile — whichever the branch actually answers. The branch goes live only with one.' : PUBLIC_CALL_COPY.shown}
      </T>
      <T variant="caption" tone="muted">{PUBLIC_CALL_COPY.separate}</T>
      <LabeledInput
        value={value}
        onChangeText={onChange}
        placeholder={PUBLIC_CALL_COPY.placeholder}
        autoCapitalize="none"
        keyboardType="phone-pad"
        accessibilityLabel="The number customers can call"
      />
    </View>
  );
}

export function PublicCallNumberCard({
  value,
  saving,
  error,
  onSave,
}: {
  value?: string | null;
  saving?: boolean;
  /** Message from a rejected save. The server owns what a valid number is, so
   *  its wording is shown verbatim rather than re-guessed here. */
  error?: string | null;
  onSave: (phone: string | null) => void;
}) {
  const [phone, setPhone] = useState(value ?? '');
  useEffect(() => setPhone(value ?? ''), [value]);

  const trimmed = phone.trim();
  const dirty = trimmed !== (value ?? '');
  const removing = !trimmed && !!value;

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <MaterialCommunityIcons name="phone-in-talk" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">
          {PUBLIC_CALL_COPY.title}
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {PUBLIC_CALL_COPY.shown}
      </T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        {PUBLIC_CALL_COPY.separate}
      </T>
      <View style={{ marginTop: space.md }}>
        <LabeledInput
          value={phone}
          onChangeText={setPhone}
          placeholder={PUBLIC_CALL_COPY.placeholder}
          autoCapitalize="none"
          keyboardType="phone-pad"
        />
      </View>
      {error ? (
        <T variant="caption" style={{ marginTop: space.xs, color: color.error }}>
          {error}
        </T>
      ) : null}
      <PillButton
        label={removing ? 'Remove number' : 'Save number'}
        variant={dirty ? 'primary' : 'soft'}
        disabled={!dirty || saving}
        loading={saving}
        style={{ marginTop: space.md }}
        onPress={() => onSave(trimmed || null)}
      />
    </Card>
  );
}
