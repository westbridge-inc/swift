/** @jsxImportSource react */
import React, { useState } from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { Card, LabeledInput, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { errorMessage } from '../../lib/apiError';
import { useMarkRefundSent } from '../../hooks/vendorops';
import { MMG_REFUND_WORDS, type MmgRefundView } from '../orders/mmgRefund';

/**
 * [BUG-HUNT-2 G08] What this store owes back by MMG, and "Refund sent": the store sends the money from its own MMG, then gives
 * Swift the reference. The amount is the server's, so a send always states exactly what is owed. Swift moves no money.
 */
export function MmgRefundOwedCard({ orderId, view }: { orderId: string; view: MmgRefundView }) {
  const mark = useMarkRefundSent();
  const [asking, setAsking] = useState(false);
  const [reference, setReference] = useState('');
  const close = () => {
    if (mark.isPending) return;
    mark.reset();
    setAsking(false);
  };
  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="body" weight="bold" accessibilityRole="header">{MMG_REFUND_WORDS.title}</T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>{view.line}</T>
      {view.canMarkSent ? (
        <View style={{ marginTop: space.md }}>
          <PillButton label={MMG_REFUND_WORDS.markSent} variant="primary" onPress={() => setAsking(true)} />
        </View>
      ) : null}
      {asking ? (
        <PopupCard visible onClose={close}>
          <PopupTitle variant="title" center>{MMG_REFUND_WORDS.sheetTitle}</PopupTitle>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>{MMG_REFUND_WORDS.sheetBody}</T>
          <LabeledInput label={MMG_REFUND_WORDS.referenceLabel} value={reference} onChangeText={setReference} autoCapitalize="characters" autoCorrect={false} />
          {mark.isError ? <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>{errorMessage(mark.error, MMG_REFUND_WORDS.fallback)}</T> : null}
          <PillButton
            label={MMG_REFUND_WORDS.confirm}
            variant="primary"
            style={{ alignSelf: 'stretch', marginTop: space.lg }}
            disabled={mark.isPending || reference.trim().length === 0}
            loading={mark.isPending}
            onPress={() => mark.mutate({ id: orderId, reference: reference.trim(), amount: view.amount }, { onSuccess: () => setAsking(false) })}
          />
          <PillButton label={MMG_REFUND_WORDS.keep} variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} disabled={mark.isPending} onPress={close} />
        </PopupCard>
      ) : null}
    </Card>
  );
}
