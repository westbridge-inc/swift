/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, Chip, PillButton, T } from '../kit';

/** The most the server takes (booking/one-at-a-time.ts MAX_BOOKING_CAPACITY). */
export const BOOKING_CAPACITY_MAX = 20;

/** The stored "how many at once", or null when the server sends none (an older server). */
export function storedBookingCapacity(store: unknown): number | null {
  const v = store && typeof store === 'object' ? (store as { bookingCapacity?: unknown }).bookingCapacity : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * [BOOK-S1 · owner C1, BOOK-S5a] A Services business's "how many bookings at once": one by
 * default (one person, one chair); a business with more chairs or staff takes more at the same
 * time, across all its services. The server judges a lowering against the bookings it already
 * holds and its refusal is shown in its own words.
 */
export function BookingCapacityCard({
  value,
  saving,
  error,
  onSave,
}: {
  value: number;
  saving?: boolean;
  error?: string | null;
  onSave: (capacity: number) => void;
}) {
  const [count, setCount] = useState(value);
  useEffect(() => setCount(value), [value]);
  const dirty = count !== value;

  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="users" size={18} color={color.brand[600]} />
        <T variant="label" weight="semibold">How many bookings at once</T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {count === 1
          ? 'One booking at a time across all your services. Choose more if several people or chairs serve customers at the same time.'
          : `Up to ${count} bookings at the same time, across all your services.`}
      </T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
        <Chip label="Fewer" selected={false} onPress={() => setCount((c) => Math.max(1, c - 1))} style={{ height: 40, minWidth: 48 }} />
        <T variant="heading" style={{ minWidth: 32, textAlign: 'center' }}>{count}</T>
        <Chip label="More" selected={false} onPress={() => setCount((c) => Math.min(BOOKING_CAPACITY_MAX, c + 1))} style={{ height: 40, minWidth: 48 }} />
      </View>
      {error ? (
        <T variant="caption" style={{ marginTop: space.xs, color: color.error }}>
          {error}
        </T>
      ) : null}
      {dirty ? (
        <PillButton
          label="Save"
          size="md"
          loading={saving}
          disabled={saving}
          onPress={() => onSave(count)}
          style={{ marginTop: space.md }}
        />
      ) : null}
    </Card>
  );
}
