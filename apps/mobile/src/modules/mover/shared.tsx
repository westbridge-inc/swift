/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { T, TonePill } from '../../kit';
import { money } from '../../lib/money';

export const GUTTER = space['2xl'];

/** A job's cash value, whatever vertical it came from. */
export function jobAmount(j: any) {
  return money(j?.totalAmount ?? j?.taxiFareTotal ?? j?.fare ?? 0);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateLabel(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function whenLabel(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function JobStatusPill({ status }: { status?: string }) {
  const s = String(status ?? '').toUpperCase();
  const label = s.replace(/_/g, ' ').toLowerCase();
  if (s === 'DELIVERED' || s === 'COMPLETED') return <TonePill label={s === 'DELIVERED' ? 'Delivered' : 'Completed'} tone="success" />;
  if (s === 'CANCELLED') return <TonePill label="Cancelled" tone="error" />;
  return <TonePill label={label || 'In progress'} tone="brand" />;
}

/** Pickup → drop-off pair with the dot / line / pin idiom. */
export function RoutePair({
  pickup,
  dropoff,
  pickupHint,
  muted,
}: {
  pickup?: string | null;
  dropoff?: string | null;
  pickupHint?: string;
  muted?: boolean;
}) {
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 16, alignItems: 'center' }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2.5, borderColor: color.text.muted }} />
        </View>
        <View style={{ flex: 1, marginLeft: space.sm }}>
          {pickupHint ? (
            <T variant="caption" tone="muted">
              {pickupHint}
            </T>
          ) : null}
          <T variant="label" weight="semibold" tone={muted ? 'muted' : 'ink'} numberOfLines={1}>
            {pickup ?? 'Pickup'}
          </T>
        </View>
      </View>
      {dropoff ? (
        <>
          <View style={{ marginLeft: 7, width: 2, height: 12, marginVertical: 2, borderRadius: 1, backgroundColor: color.border.subtle }} />
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 16, alignItems: 'center' }}>
              <Feather name="map-pin" size={14} color={color.brand[500]} />
            </View>
            <T variant="label" weight={muted ? 'regular' : 'semibold'} tone={muted ? 'muted' : 'ink'} numberOfLines={1} style={{ flex: 1, marginLeft: space.sm }}>
              {dropoff}
            </T>
          </View>
        </>
      ) : null}
    </View>
  );
}
