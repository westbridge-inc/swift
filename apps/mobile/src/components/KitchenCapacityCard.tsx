/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, Chip, PillButton, T } from '../kit';

import { kitchenCapacityLine, nextKitchenCapacity } from '../lib/kitchenCapacity';

export { KITCHEN_CAPACITY_MAX, kitchenCapacityLine, nextKitchenCapacity, storedKitchenCapacity } from '../lib/kitchenCapacity';

/**
 * [RIDER-SAFE 4 · FUL-007] "How many orders at once": a store can cap how many
 * orders it holds (new, cooking or ready) so it is never drowned; at the cap
 * customers cannot order until one is collected or cancelled (asked to try
 * again in a few minutes); nothing queues. No limit by default.
 */
export function KitchenCapacityCard({
  value,
  saving,
  error,
  onSave,
}: {
  value: number | null;
  saving?: boolean;
  error?: string | null;
  onSave: (capacity: number | null) => void;
}) {
  const [count, setCount] = useState<number | null>(value);
  useEffect(() => setCount(value), [value]);
  const dirty = count !== value;

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="layers" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">How many orders at once</T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {kitchenCapacityLine(count)}
      </T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
        <Chip label="Fewer" selected={false} onPress={() => setCount((c) => nextKitchenCapacity(c, 'fewer'))} style={{ height: 40, minWidth: 48 }} />
        <T variant="heading" style={{ minWidth: 72, textAlign: 'center' }}>{count == null ? 'No limit' : count}</T>
        <Chip label={count == null ? 'Set a limit' : 'More'} selected={false} onPress={() => setCount((c) => nextKitchenCapacity(c, 'more'))} style={{ height: 40, minWidth: 48 }} />
      </View>
      {error ? (
        <T variant="caption" style={{ marginTop: space.xs, color: color.error }}>
          {error}
        </T>
      ) : null}
      {dirty ? (
        <PillButton label="Save" size="md" loading={saving} disabled={saving} onPress={() => onSave(count)} style={{ marginTop: space.md }} />
      ) : null}
    </Card>
  );
}
