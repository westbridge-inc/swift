/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, LabeledInput, PillButton, T } from '../kit';

/** The refund rule's limit, as the API checks it (vendor/refund-rule.ts). */
export const REFUND_RULE_MAX = 300;

/**
 * [R3 · Consumer Affairs Act 2011 s.70(3)] The store's own refund rule: what its store page shows under "Refunds",
 * followed by the customer's statutory rights. The owner's to give (the API refuses anyone else), in plain words;
 * empty takes it down and the page says "Ask the store". The server judges the words (length, no links, no goods
 * Swift never carries) and its refusal is shown in its own words, like the call-us number beside it.
 */
export function RefundRuleCard({
  value,
  saving,
  error,
  onSave,
}: {
  value?: string | null;
  saving?: boolean;
  error?: string | null;
  onSave: (rule: string | null) => void;
}) {
  const [rule, setRule] = useState(value ?? '');
  useEffect(() => setRule(value ?? ''), [value]);

  const trimmed = rule.trim();
  const dirty = trimmed !== (value ?? '');
  const removing = !trimmed && !!value;

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <MaterialCommunityIcons name="cash-refund" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">
          Your refund rule
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        Customers see this on your store page under “Refunds”, followed by their rights under the Consumer Affairs
        Act 2011. Leave it empty and your page says “Ask the store”.
      </T>
      <View style={{ marginTop: space.md }}>
        <LabeledInput
          value={rule}
          onChangeText={setRule}
          placeholder="Bring it back within 3 days with your receipt for a refund or exchange."
          multiline
          maxLength={REFUND_RULE_MAX}
          accessibilityLabel="Your refund rule"
        />
      </View>
      {error ? (
        <T variant="caption" style={{ marginTop: space.xs, color: color.error }}>
          {error}
        </T>
      ) : null}
      <PillButton
        label={removing ? 'Remove refund rule' : 'Save refund rule'}
        variant={dirty ? 'primary' : 'soft'}
        disabled={!dirty || saving}
        loading={saving}
        style={{ marginTop: space.md }}
        onPress={() => onSave(trimmed || null)}
      />
    </Card>
  );
}
