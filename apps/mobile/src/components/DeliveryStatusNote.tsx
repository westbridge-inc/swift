/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { T } from '../kit';

import { deliveryStatusNote } from '../lib/kitchenCapacity';

/**
 * [RIDER-SAFE 4/5 · COORD ruling 29 Oct 2026] The store sees WHY customers
 * cannot order delivery: Swift paused delivery in its area, or its own orders
 * are waiting for riders (new delivery orders pause by themselves and restart
 * when a rider takes one). Pickup stays open. Nothing while delivery is open.
 */
export function DeliveryStatusNote({ status }: { status: unknown }) {
  const note = deliveryStatusNote(status);
  if (!note) return null;
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }} accessibilityRole="alert">
      <Feather name="alert-circle" size={16} color={color.warning} />
      <View style={{ flex: 1 }}>
        <T variant="label" weight="semibold">{note.title}</T>
        <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{note.body}</T>
      </View>
    </View>
  );
}
