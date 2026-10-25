/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { PillButton, T } from '../../kit';
import { mmgClaimPresentation, type MmgClaimAction, type MmgClaimView } from './mmgClaim';

/**
 * [ORDER-SPINE S1-6] The customer's door to "I paid" / "I didn't pay" on a
 * direct-MMG order. Renders ONLY what the server projected: no control the
 * server would refuse, and every control inert while a claim is in flight.
 */
export function MmgPaymentClaimCard({
  view,
  pending,
  onClaim,
}: {
  view: MmgClaimView;
  pending: boolean;
  onClaim: (action: MmgClaimAction) => void;
}) {
  const p = mmgClaimPresentation(view);
  const background = p.tone === 'warning' ? color.soft.warning : p.tone === 'success' ? color.soft.success : color.surface.sunken;
  const titleTone = p.tone === 'warning' ? 'warning' : p.tone === 'success' ? 'success' : 'deep';
  return (
    <View style={{ borderRadius: radius.lg, backgroundColor: background, padding: space.lg, marginTop: space.xl }}>
      <T variant="body" weight="bold" tone={titleTone} accessibilityRole="header">
        {p.title}
      </T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        {p.body}
      </T>
      {p.actions.map((action) => (
        <PillButton
          key={action.label}
          label={action.label}
          variant={action.paid ? 'outline' : 'soft'}
          size="md"
          loading={pending}
          disabled={pending}
          onPress={() => onClaim(action)}
          style={{ marginTop: space.md }}
        />
      ))}
    </View>
  );
}
