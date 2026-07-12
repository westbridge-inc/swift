/** @jsxImportSource react */
import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T, TonePill, cardShadow } from '../../kit';

export const GUTTER = space['2xl'];

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function prettyVendorType(t?: string) {
  return t === 'SUPERMARKET' ? 'Grocery' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant';
}

// ─── Order helpers ───────────────────────────────────────────────────────────

export type VendorOrderActionKind = 'accept' | 'preparing' | 'ready' | 'reject' | 'complete-pickup' | 'complete-appointment';

export function orderActions(order: any): { label: string; action: VendorOrderActionKind }[] {
  const s = (order?.status || '').toUpperCase();
  const isPickup = order?.fulfillment === 'PICKUP';
  const isAppt = order?.fulfillment === 'APPOINTMENT';
  if (s === 'PENDING' || s === 'PLACED')
    return [{ label: 'Accept', action: 'accept' }, { label: isAppt ? 'Decline' : 'Reject', action: 'reject' }];
  // Appointments skip prepare/ready — accepting books the slot, then the vendor marks it done.
  if (isAppt && (s === 'ACCEPTED' || s === 'CONFIRMED')) return [{ label: 'Mark complete', action: 'complete-appointment' }];
  if (s === 'ACCEPTED' || s === 'CONFIRMED') return [{ label: 'Start preparing', action: 'preparing' }];
  if (s === 'PREPARING') return [{ label: isPickup ? 'Ready for pickup' : 'Mark ready', action: 'ready' }];
  // Takeaway: the vendor closes the order when the customer collects it (no rider).
  if ((s === 'READY' || s === 'READY_FOR_PICKUP') && isPickup) return [{ label: 'Mark picked up', action: 'complete-pickup' }];
  return [];
}

export function timeAgo(iso?: string) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clock(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** Relative for the live board, absolute once "412h ago" would read as noise. */
export function fmtWhen(iso?: string) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 48 * 60) return timeAgo(iso);
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(d)}`;
}

export function fmtClock(iso?: string) {
  if (!iso) return '';
  return clock(new Date(iso));
}

export function fmtDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// Appointment slot → "Mon 14 Jul · 2:30 PM" (manual format; Hermes Intl is limited).
export function formatSlot(iso?: string) {
  if (!iso) return 'Time to be confirmed';
  const d = new Date(iso);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${clock(d)}`;
}

export function prettyStatus(status?: string) {
  const s = (status || '').replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Order status pill — "New" pops in solid brand; the rest are soft tints. */
export function OrderStatusPill({ status }: { status: string }) {
  const s = (status || '').toUpperCase();
  if (s === 'PENDING' || s === 'PLACED') {
    return (
      <View style={{ borderRadius: 9999, paddingHorizontal: space.md, paddingVertical: 5, backgroundColor: color.brand[500] }}>
        <T variant="caption" weight="semibold" tone="onBrand">
          New
        </T>
      </View>
    );
  }
  if (s === 'ACCEPTED' || s === 'CONFIRMED') return <TonePill label="Accepted" tone="brand" />;
  if (s === 'PREPARING') return <TonePill label="Preparing" tone="neutral" />;
  if (s === 'READY' || s === 'READY_FOR_PICKUP') return <TonePill label="Ready" tone="success" />;
  if (s === 'DELIVERED' || s === 'COMPLETED') return <TonePill label={prettyStatus(s)} tone="success" />;
  if (s === 'CANCELLED') return <TonePill label="Cancelled" tone="error" />;
  return <TonePill label={s.replace(/_/g, ' ').toLowerCase()} tone="neutral" />;
}

/** Small soft tag beside the order number (Takeaway / Appointment). */
export function FulfillmentTag({ icon, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: 9999,
        backgroundColor: color.brand[50],
        paddingHorizontal: space.sm,
        paddingVertical: 2,
      }}
    >
      <MaterialCommunityIcons name={icon} size={12} color={color.brand[500]} />
      <T variant="caption" weight="semibold" tone="deep">
        {label}
      </T>
    </View>
  );
}

// ─── Operator chrome ─────────────────────────────────────────────────────────

export function SubHeader({
  title,
  navigation,
  action,
  hideBack,
}: {
  title: string;
  navigation: any;
  action?: { label: string; onPress: () => void; disabled?: boolean };
  hideBack?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: GUTTER,
        height: 56,
      }}
    >
      {hideBack ? (
        <View style={{ width: 44 }} />
      ) : (
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          {({ pressed }) => (
            <View style={{ width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
              <Feather name="chevron-left" size={24} color={color.text.primary} />
            </View>
          )}
        </Pressable>
      )}
      <T variant="heading" numberOfLines={1} style={{ flex: 1, textAlign: 'center', paddingHorizontal: space.md }}>
        {title}
      </T>
      {action ? (
        <Pressable onPress={action.onPress} disabled={action.disabled} hitSlop={8}>
          {({ pressed }) => (
            <View style={{ minWidth: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
              <T variant="body" weight="semibold" tone={action.disabled ? 'muted' : 'brand'}>
                {action.label}
              </T>
            </View>
          )}
        </Pressable>
      ) : (
        <View style={{ width: 44 }} />
      )}
    </View>
  );
}

/** Compact inline text field (pill outline) for dense operator forms. */
export function InlineInput({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  multiline,
  style,
  center,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'number-pad' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  multiline?: boolean;
  style?: object;
  center?: boolean;
}) {
  return (
    <View
      style={[
        {
          borderRadius: multiline ? radius.lg : 9999,
          borderWidth: 1,
          borderColor: color.border.subtle,
          backgroundColor: color.surface.base,
          paddingHorizontal: space.lg,
          paddingVertical: multiline ? space.md : 0,
          height: multiline ? undefined : 48,
          minHeight: multiline ? 64 : undefined,
          justifyContent: multiline ? undefined : 'center',
        },
        style,
      ]}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.text.muted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        multiline={multiline}
        style={{
          fontFamily: 'Inter',
          fontSize: 15,
          color: color.text.primary,
          paddingVertical: 0,
          textAlign: center ? 'center' : undefined,
          minHeight: multiline ? 48 : undefined,
        }}
      />
    </View>
  );
}

/** KPI tile; `delta` (optional) renders top-right — e.g. a period-over-period move. */
export function KpiTile({
  icon,
  value,
  label,
  delta,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  value: string;
  label: string;
  delta?: React.ReactNode;
}) {
  return (
    <View style={[{ flex: 1, borderRadius: radius.lg, backgroundColor: color.surface.base, padding: space.md }, cardShadow]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <MaterialCommunityIcons name={icon} size={18} color={color.brand[500]} />
        {delta ?? null}
      </View>
      <T variant="body" weight="bold" numberOfLines={1} style={{ marginTop: 4 }}>
        {value}
      </T>
      <T variant="caption" tone="muted" numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

/** Period-over-period move, computed from the backend's own daily series. */
export function DeltaBadge({ cur, prev }: { cur: number; prev: number | null }) {
  if (prev == null) return null;
  if (prev <= 0) {
    return cur > 0 ? (
      <T variant="caption" weight="semibold" style={{ color: color.success }}>
        new
      </T>
    ) : null;
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0)
    return (
      <T variant="caption" weight="semibold" tone="muted">
        level
      </T>
    );
  const up = pct > 0;
  return (
    <T variant="caption" weight="semibold" style={{ color: up ? color.success : color.error }}>
      {up ? '▲' : '▼'} {Math.abs(pct)}%
    </T>
  );
}
