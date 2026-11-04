/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { PillButton, T } from '../../kit';
import { MMG_REFUND_WORDS, mmgRefundTone, type MmgRefundView } from './mmgRefund';

/**
 * [BUG-HUNT-2 G08] The customer's MMG refund: who owes what, and "Did it arrive?". Renders only what the server projected, and
 * every control is inert while an answer is on its way. Swift holds none of this money.
 */
export function MmgRefundCard({ view, pending, error, onAnswer }: { view: MmgRefundView; pending: boolean; error: string | null; onAnswer: (sendId: string, received: boolean) => void }) {
  const tone = mmgRefundTone(view);
  const background = tone === 'warning' ? color.soft.warning : tone === 'success' ? color.soft.success : color.surface.sunken;
  return (
    <View style={{ borderRadius: radius.lg, backgroundColor: background, padding: space.lg, marginTop: space.xl }}>
      <T variant="body" weight="bold" tone={tone === 'neutral' ? 'deep' : tone} accessibilityRole="header">{MMG_REFUND_WORDS.title}</T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>{view.line}</T>
      {view.canAnswer && view.sendId ? (
        <>
          <PillButton label={MMG_REFUND_WORDS.arrived} variant="outline" size="md" loading={pending} disabled={pending} onPress={() => onAnswer(view.sendId as string, true)} style={{ marginTop: space.md }} />
          <PillButton label={MMG_REFUND_WORDS.notArrived} variant="soft" size="md" loading={pending} disabled={pending} onPress={() => onAnswer(view.sendId as string, false)} style={{ marginTop: space.md }} />
        </>
      ) : null}
      {error ? <T variant="caption" tone="error" style={{ marginTop: space.sm }}>{error}</T> : null}
    </View>
  );
}
