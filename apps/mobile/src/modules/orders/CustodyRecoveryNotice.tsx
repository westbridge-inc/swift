/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { PillButton, T } from '../../kit';
import type { PartyCaseView } from '../../lib/custodyRecovery';

/**
 * [AF-MOB-006] What the customer (or the store) is told when a delivery went
 * wrong after pickup. The server writes the headline and the sentence — who is
 * handling it and what happens next, including the honest money line on a
 * return — so this card renders them as-is and never invents a promise. The
 * store gets its one action (the goods are back) through `action`.
 */
export function CustodyRecoveryNotice({
  view,
  action,
}: {
  view: PartyCaseView;
  action?: { label: string; onPress: () => void; pending: boolean };
}) {
  return (
    <View
      accessibilityLabel="Delivery recovery"
      style={{ borderRadius: radius.lg, backgroundColor: view.open ? color.soft.warning : color.surface.sunken, padding: space.lg, marginTop: space.xl }}
    >
      <T variant="body" weight="bold" tone={view.open ? 'warning' : 'deep'} accessibilityRole="header">
        {view.headline}
      </T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        {view.body}
      </T>
      {action ? (
        <PillButton
          label={action.label}
          size="md"
          loading={action.pending}
          disabled={action.pending}
          style={{ marginTop: space.md }}
          onPress={action.onPress}
        />
      ) : null}
    </View>
  );
}
