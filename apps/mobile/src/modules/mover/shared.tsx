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

/** §4d — who the mover is fronting cash for, shown BEFORE accepting: trust
 *  level, completed orders, and any recent strikes (the real warning). */
export function CustomerTrustBadge({ trust, cash }: { trust?: { trustLevel: string; completedOrders: number; strikes: number } | null; cash?: boolean }) {
  if (!trust) return null;
  const risky = trust.strikes > 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'center', marginTop: space.sm }}>
      <Feather name={risky ? 'alert-triangle' : 'shield'} size={12} color={risky ? color.warning : color.text.muted} />
      <T variant="caption" weight={risky ? 'bold' : 'semibold'} tone={risky ? undefined : 'muted'} style={risky ? { color: color.warning } : undefined}>
        {trust.trustLevel} · {trust.completedOrders} completed{trust.strikes > 0 ? ` · ${trust.strikes} strike${trust.strikes === 1 ? '' : 's'}` : ''}
        {cash && risky ? ' — cash job, your float' : ''}
      </T>
    </View>
  );
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
  dark,
}: {
  pickup?: string | null;
  dropoff?: string | null;
  pickupHint?: string;
  muted?: boolean;
  /** Render on the earner app's dark cards (dashboard plan Phase B). */
  dark?: boolean;
}) {
  const inkStyle = dark ? { color: '#FFFFFF' } : undefined;
  const mutedStyle = dark ? { color: 'rgba(255,255,255,0.55)' } : undefined;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 16, alignItems: 'center' }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2.5, borderColor: dark ? 'rgba(255,255,255,0.55)' : color.text.muted }} />
        </View>
        <View style={{ flex: 1, marginLeft: space.sm }}>
          {pickupHint ? (
            <T variant="caption" tone="muted" style={mutedStyle}>
              {pickupHint}
            </T>
          ) : null}
          <T variant="label" weight="semibold" tone={muted ? 'muted' : 'ink'} numberOfLines={1} style={muted ? mutedStyle : inkStyle}>
            {pickup ?? 'Pickup'}
          </T>
        </View>
      </View>
      {dropoff ? (
        <>
          <View style={{ marginLeft: 7, width: 2, height: 12, marginVertical: 2, borderRadius: 1, backgroundColor: dark ? 'rgba(255,255,255,0.15)' : color.border.subtle }} />
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 16, alignItems: 'center' }}>
              <Feather name="map-pin" size={14} color={color.brand[500]} />
            </View>
            <T variant="label" weight={muted ? 'regular' : 'semibold'} tone={muted ? 'muted' : 'ink'} numberOfLines={1} style={[{ flex: 1, marginLeft: space.sm }, muted ? mutedStyle : inkStyle]}>
              {dropoff}
            </T>
          </View>
        </>
      ) : null}
    </View>
  );
}
