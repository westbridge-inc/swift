/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View, type ViewStyle } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { withAlpha, color, radius, space } from '@swift/ui';
import { Card, LabeledInput, PillButton, T } from '../kit';
import { fmtWhen } from '../lib/stepUp';

/**
 * Attach your OWN MMG (Mobile Money Guyana) "pay me" link so customers can pay
 * you directly — the money goes to your MMG, never through Swift. Opt-in;
 * clearing it keeps you cash-only. (MMG Phase 1.)
 *
 * [ALG-34 / ALG-INV-14] Changing the link is where an account takeover would
 * cash out, so the server stages a change behind a cool-off with the OLD link
 * still live. This card shows that pending state exactly as the server sent
 * it — the time it takes effect is the server's, never computed here — and
 * carries the one-tap cancel that also signs out every other device.
 */
export function MmgPayLinkCard({
  value,
  pending,
  saving,
  cancelling,
  error,
  readOnly,
  onSave,
  onCancelPending,
  who,
  dark,
}: {
  value?: string | null;
  /** A staged change the server is holding: the new link and when it goes live. */
  pending?: { url: string; applyAt: string | null } | null;
  saving?: boolean;
  cancelling?: boolean;
  /** The server's sentence when a save was refused. */
  error?: string | null;
  /** A manager sees the link; only the owner may change where the money goes. */
  readOnly?: boolean;
  onSave: (url: string | null) => void;
  onCancelPending?: () => void;
  who: 'store' | 'rides';
  /** Render on the earner app's dark surfaces (dashboard plan Phase E). */
  dark?: boolean;
}) {
  const [url, setUrl] = useState(value ?? '');
  useEffect(() => setUrl(value ?? ''), [value]);

  const trimmed = url.trim();
  const dirty = trimmed !== (value ?? '');
  const payer = who === 'store' ? 'Customers' : 'Riders';
  const payerLower = who === 'store' ? 'customers' : 'riders';
  const darkCard: ViewStyle = dark
    ? { backgroundColor: color.text.primary, borderWidth: 1, borderColor: withAlpha(color.white, 0.08) }
    : {};
  const mutedStyle = dark ? { color: withAlpha(color.white, 0.55) } : undefined;
  const when = fmtWhen(pending?.applyAt);

  return (
    <Card style={{ marginBottom: space.lg, ...darkCard }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <MaterialCommunityIcons name="cellphone-check" size={18} color={dark ? color.brand[500] : color.brand[600]} />
        <T variant="label" weight="semibold" style={dark ? { color: color.white } : undefined}>
          Your MMG pay link
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4, ...mutedStyle }}>
        {payer} can pay you directly on your own MMG — the money goes straight to you, Swift never holds it. Leave it empty to stay cash-only.
      </T>

      {pending ? (
        <View
          testID="mmg-link-pending"
          style={{
            marginTop: space.md,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: dark ? withAlpha(color.white, 0.06) : color.brand[50],
            gap: space.xs,
          }}
        >
          <T variant="label" weight="semibold" style={dark ? { color: color.white } : undefined}>
            {when ? `New link takes effect ${when}` : 'New link is waiting for its cool-off'}
          </T>
          <T variant="caption" tone="muted" numberOfLines={1} style={mutedStyle}>
            {pending.url}
          </T>
          <T variant="caption" tone="muted" style={mutedStyle}>
            {value
              ? `Until then, ${payerLower} keep paying to your current link.`
              : `Until then, you stay cash-only.`}
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
          <T variant="label" numberOfLines={1} style={dark ? { color: color.white } : undefined}>
            {value ?? 'Cash-only'}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: 4, ...mutedStyle }}>
            Only the store owner can change where the money goes.
          </T>
        </View>
      ) : (
        <>
          <View style={{ marginTop: space.md }}>
            <LabeledInput
              dark={dark}
              value={url}
              onChangeText={setUrl}
              placeholder="Paste your MMG pay link"
              autoCapitalize="none"
              keyboardType="url"
              error={error ?? undefined}
            />
          </View>
          {trimmed && dirty ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm, ...mutedStyle }}>
              We’ll text you a code first. The new link goes live after a hold — your current link keeps working until then, and we’ll show you exactly when.
            </T>
          ) : null}
          <PillButton
            label={!trimmed && value ? 'Remove link' : 'Save link'}
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
