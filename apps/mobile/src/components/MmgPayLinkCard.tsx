/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View, type ViewStyle } from 'react-native';
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
  dark,
}: {
  value?: string | null;
  saving?: boolean;
  onSave: (url: string | null) => void;
  who: 'store' | 'rides';
  /** Render on the earner app's dark surfaces (dashboard plan Phase E). */
  dark?: boolean;
}) {
  const [url, setUrl] = useState(value ?? '');
  useEffect(() => setUrl(value ?? ''), [value]);

  const trimmed = url.trim();
  const dirty = trimmed !== (value ?? '');
  const payer = who === 'store' ? 'Customers' : 'Riders';
  const darkCard: ViewStyle = dark
    ? { backgroundColor: '#17171B', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }
    : {};

  return (
    <Card style={{ marginBottom: space.lg, ...darkCard }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <MaterialCommunityIcons name="cellphone-check" size={18} color={dark ? color.brand[500] : color.brand[600]} />
        <T variant="label" weight="semibold" style={dark ? { color: '#FFFFFF' } : undefined}>
          Your MMG pay link
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4, ...(dark ? { color: 'rgba(255,255,255,0.55)' } : {}) }}>
        {payer} can pay you directly on your own MMG — the money goes straight to you, Swift never holds it. Leave it empty to stay cash-only.
      </T>
      <View style={{ marginTop: space.md }}>
        <LabeledInput
          dark={dark}
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
