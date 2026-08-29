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
          Your call-us number
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        Customers see this on your store page and can call before they order. Your landline or
        your mobile — whichever you actually answer. Leave it empty to hide it.
      </T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        This is separate from the number you sign in with, which stays private.
      </T>
      <View style={{ marginTop: space.md }}>
        <LabeledInput
          value={phone}
          onChangeText={setPhone}
          placeholder="+592 225 1234"
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
