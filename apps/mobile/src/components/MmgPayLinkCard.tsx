/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, LabeledInput, PillButton, T } from '../kit';

/**
 * Attach your OWN MMG (Mobile Money Guyana) "pay me" link so customers can pay
 * you directly — the money goes to your MMG, never through Swift. Opt-in;
 * clearing it keeps you cash-only. (MMG Phase 1.)
 */
export function MmgPayLinkCard({
  value,
  saving,
  onSave,
  who,
}: {
  value?: string | null;
  saving?: boolean;
  onSave: (url: string | null) => void;
  who: 'store' | 'rides';
}) {
  const [url, setUrl] = useState(value ?? '');
  useEffect(() => setUrl(value ?? ''), [value]);

  const trimmed = url.trim();
  const dirty = trimmed !== (value ?? '');
  const payer = who === 'store' ? 'Customers' : 'Riders';

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <MaterialCommunityIcons name="cellphone-check" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">
          Your MMG pay link
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {payer} can pay you directly on your own MMG — the money goes straight to you, Swift never holds it. Leave it empty to stay cash-only.
      </T>
      <View style={{ marginTop: space.md }}>
        <LabeledInput
          value={url}
          onChangeText={setUrl}
          placeholder="Paste your MMG pay link"
          autoCapitalize="none"
          keyboardType="url"
        />
      </View>
      <PillButton
        label={!trimmed && value ? 'Remove link' : 'Save link'}
        variant={dirty ? 'primary' : 'soft'}
        disabled={!dirty || saving}
        loading={saving}
        style={{ marginTop: space.md }}
        onPress={() => onSave(trimmed || null)}
      />
    </Card>
  );
}
