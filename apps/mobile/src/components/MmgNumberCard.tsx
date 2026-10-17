/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, LabeledInput, PillButton, T } from '../kit';
import { fmtWhen } from '../lib/stepUp';

/**
 * [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The store's OWN MMG number — where a customer who chose MMG pays
 * the order, directly, in MMG's own app. Swift never holds, moves or checks that money. The number is shown
 * only to that order's customer, only after the store accepts; never on the storefront.
 *
 * [ALG-34 parity] A change is where an account takeover would cash out, so the server stages it behind a
 * cool-off with the OLD number still live, texts the owner, and offers the one-tap cancel that also signs
 * out every other device. This card shows that state exactly as the server sent it.
 */
export function MmgNumberCard({
  value,
  pending,
  saving,
  cancelling,
  error,
  readOnly,
  onSave,
  onCancelPending,
}: {
  /** The live number ("+5926001234"), or null when the store takes no MMG. */
  value?: string | null;
  /** A staged change the server is holding: the new number and when it goes live. */
  pending?: { number: string; applyAt: string | null } | null;
  saving?: boolean;
  cancelling?: boolean;
  /** The server's sentence when a save was refused. */
  error?: string | null;
  /** A manager sees the number; only the owner may change where the money goes. */
  readOnly?: boolean;
  onSave: (number: string | null) => void;
  onCancelPending?: () => void;
}) {
  const [input, setInput] = useState(value ?? '');
  useEffect(() => setInput(value ?? ''), [value]);
  const trimmed = input.trim();
  const dirty = trimmed !== (value ?? '');
  const when = fmtWhen(pending?.applyAt);

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <MaterialCommunityIcons name="cellphone-check" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">
          Your MMG number
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        Customers who choose MMG see this number on their order after you accept it, and pay you directly. Tap
        “Paid by MMG” on the order when the money is in your account. Leave it empty to take cash only.
      </T>

      {pending ? (
        <View
          testID="mmg-number-pending"
          style={{ marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.brand[50], gap: space.xs }}
        >
          <T variant="label" weight="semibold">
            {when ? `New number takes effect ${when}` : 'New number is waiting for its cool-off'}
          </T>
          <T variant="caption" tone="muted" numberOfLines={1}>
            {pending.number}
          </T>
          <T variant="caption" tone="muted">
            {value ? 'Until then, customers keep paying your current number.' : 'Until then, you take cash only.'}
          </T>
          {onCancelPending ? (
            <PillButton
              label="This wasn’t me — cancel and sign out other devices"
              variant="soft"
              size="md"
              loading={cancelling}
              disabled={cancelling}
              style={{ marginTop: space.sm }}
              onPress={onCancelPending}
            />
          ) : null}
        </View>
      ) : null}

      {readOnly ? (
        <View style={{ marginTop: space.md }}>
          <T variant="label" numberOfLines={1}>
            {value ?? 'Cash only'}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
            Only the store owner can change where the money goes.
          </T>
        </View>
      ) : (
        <>
          <View style={{ marginTop: space.md }}>
            <LabeledInput
              value={input}
              onChangeText={setInput}
              placeholder="+592 600 1234"
              keyboardType="phone-pad"
              error={error ?? undefined}
            />
          </View>
          {trimmed && dirty ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              We’ll text you a code first. The new number goes live after a hold — your current number keeps working until then, and we’ll show you exactly when.
            </T>
          ) : null}
          <PillButton
            label={!trimmed && value ? 'Remove number' : 'Save number'}
            variant={dirty ? 'primary' : 'soft'}
            disabled={!dirty || saving}
            loading={saving}
            style={{ marginTop: space.md }}
            onPress={() => onSave(trimmed || null)}
          />
        </>
      )}
    </Card>
  );
}
