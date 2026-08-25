/** @jsxImportSource react */
import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T, TonePill } from '../../kit';

export const GUTTER = space['2xl'];

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function prettyVendorType(t?: string) {
  return t === 'SUPERMARKET' ? 'Grocery' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant';
}

// ─── Order helpers ───────────────────────────────────────────────────────────

export type VendorOrderActionKind = 'accept' | 'preparing' | 'ready' | 'reject' | 'complete-pickup' | 'complete-appointment' | 'confirm-payment';

/** Statuses where a rider owns the status lane; kitchen progress then rides
 *  the preparingAt/readyAt timestamps (see the vendor prep routes). */
const COURIER_ACTIVE = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

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
  // A rider claimed the order before the kitchen tapped anything (the normal
  // case when movers are close) — the buttons keep working via timestamps.
  if (COURIER_ACTIVE.includes(s)) {
    if (!order?.preparingAt) return [{ label: 'Start preparing', action: 'preparing' }];
    if (!order?.readyAt) return [{ label: 'Mark ready', action: 'ready' }];
    return [];
  }
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

/**
 * The board's THREE deliberate pill treatments. An order walking the lane is
 * the one thing a vendor reads across the room, so each stage owns a different
 * weight of ink — not three shades of the same chip:
 *   now    — maroon fill, white text     · it needs you NOW (the only solid one)
 *   inHand — blush fill, maroon text     · in hand, nothing owed from you yet
 *   done   — viridian tint, green text   · done, waiting on someone else
 * One set of metrics for all three, so the row does not shift a pixel as the
 * order moves. Colours are tokens; the treatment map is the only place they
 * are chosen.
 */
const PILL_TREATMENT = {
  now: { bg: color.brand[500], fg: color.text.onBrand },
  inHand: { bg: color.brand[50], fg: color.brand[600] },
  done: { bg: color.soft.success, fg: color.success },
} as const;

function BoardPill({ label, treatment }: { label: string; treatment: keyof typeof PILL_TREATMENT }) {
  const t = PILL_TREATMENT[treatment];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        borderRadius: radius.full,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        backgroundColor: t.bg,
      }}
    >
      <T variant="caption" weight="semibold" style={{ color: t.fg }}>
        {label}
      </T>
    </View>
  );
}

/** Order status pill — "New" pops in solid brand; the rest are soft tints. */
export function OrderStatusPill({ status }: { status: string }) {
  const s = (status || '').toUpperCase();
  if (s === 'PENDING' || s === 'PLACED') return <BoardPill label="New" treatment="now" />;
  if (s === 'ACCEPTED' || s === 'CONFIRMED') return <BoardPill label="Accepted" treatment="inHand" />;
  if (s === 'PREPARING') return <BoardPill label="Preparing" treatment="inHand" />;
  if (s === 'READY' || s === 'READY_FOR_PICKUP') return <BoardPill label="Ready" treatment="done" />;
  if (s === 'RIDER_ASSIGNED') return <TonePill label="Rider assigned" tone="brand" />;
  if (s === 'RIDER_EN_ROUTE_PICKUP') return <TonePill label="Rider en route" tone="brand" />;
  if (s === 'RIDER_ARRIVED_PICKUP') return <TonePill label="Rider at counter" tone="brand" />;
  if (s === 'PICKED_UP' || s === 'EN_ROUTE_DELIVERY' || s === 'ARRIVED') return <TonePill label="Out for delivery" tone="neutral" />;
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
        gap: space.xs,
        borderRadius: radius.full,
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
  // Same gluestack-grade field language as the kit LabeledInput: a defined
  // rounded-rectangle with a visible resting border and a brand focus state,
  // not a faint pill.
  const [focused, setFocused] = React.useState(false);
  return (
    <View
      style={[
        {
          borderRadius: radius.md,
          borderWidth: focused ? 1.5 : 1,
          borderColor: focused ? color.brand[500] : color.border.strong,
          backgroundColor: color.surface.base,
          paddingHorizontal: space.lg,
          paddingVertical: multiline ? space.md : 0,
          height: multiline ? undefined : 52,
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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          fontFamily: 'Hanken',
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

/**
 * KPI tile; `delta` (optional) renders top-right — e.g. a period-over-period move.
 *
 * A white card on paper held up by a HAIRLINE, not a shadow: the number is the
 * only loud thing on it. The display face at `numL` (tabular) is what a vendor
 * reads at arm's length; the label beneath stays muted so the pair reads as one
 * fact, and the glyph is a quiet ink marker rather than a maroon dot — maroon on
 * this board belongs to the New pill and the one primary CTA.
 */
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
    <View
      style={{
        flex: 1,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: color.border.subtle,
        backgroundColor: color.surface.base,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 18 }}>
        <MaterialCommunityIcons name={icon} size={16} color={color.text.muted} />
        {delta ?? null}
      </View>
      <T variant="numL" numberOfLines={1} style={{ marginTop: space.xs }}>
        {value}
      </T>
      <T variant="caption" tone="muted" numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

/** Period-over-period move, computed from the backend's own daily series.
 *  A move up is viridian, not maroon: on the board maroon is reserved for the
 *  one thing that needs a tap (the New pill, the primary CTA), and a delta is
 *  never that. Down and level stay muted — the number is the story, not the
 *  chip. */
export function DeltaBadge({ cur, prev }: { cur: number; prev: number | null }) {
  if (prev == null) return null;
  if (prev <= 0) {
    return cur > 0 ? (
      <T variant="caption" weight="semibold" tone="success">
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
    <T variant="caption" weight="semibold" tone={up ? 'success' : 'muted'}>
      {up ? '▲' : '▼'} {Math.abs(pct)}%
    </T>
  );
}

// ─── The first morning ───────────────────────────────────────────────────────

/**
 * BOARD FIRST-RUN [UXR-W-003 · audit item 01].
 *
 * A vendor who went live an hour ago and a vendor between lunch rushes used to
 * see exactly the same thing: a small tinted tile, a grey check, and "You are
 * all caught up". For the first vendor that copy is simply FALSE — they have
 * never had anything to catch up on — and the board they were sold ("the queue
 * is the job") opens as a void on the morning it matters most.
 *
 * The split is made on a real fact, lifetime orders, not on a guess. Zero-ever
 * gets this card; everyone else keeps the quiet tile. An outage is neither: the
 * WR-016 error card still owns that case, because "we cannot reach the board"
 * must never be dressed as "you are new".
 *
 * Anatomy is the house's existing loud voice — the deep-maroon promo treatment,
 * display face, a watermark pictogram — so it reads as Swift talking, not as an
 * empty state apologising. Every row states a LIVE fact pulled from the store,
 * never a static checklist: real photo counts, the real opening state, the real
 * share link. A row that has nothing true to say does not appear.
 */
export function BoardFirstRunRow({
  index,
  label,
  detail,
  done,
  onPress,
}: {
  index: number;
  label: string;
  detail: string;
  done?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={`${label}. ${detail}`}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            minHeight: 44,
            paddingVertical: space.sm,
            paddingHorizontal: space.md,
            borderRadius: radius.md,
            backgroundColor: color.surface.onBrand,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: color.surface.onBrand,
            }}
          >
            {done ? (
              <Feather name="check" size={14} color={color.white} />
            ) : (
              <T variant="micro" weight="bold" tone="onBrand">
                {index}
              </T>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <T variant="label" weight="semibold" tone="onBrand" numberOfLines={1}>
              {label}
            </T>
            <T variant="caption" tone="onBrand" numberOfLines={1} style={{ opacity: 0.82, marginTop: 1 }}>
              {detail}
            </T>
          </View>
          {onPress ? <Feather name="chevron-right" size={16} color={color.white} style={{ opacity: 0.7 }} /> : null}
        </View>
      )}
    </Pressable>
  );
}

export function BoardFirstRun({
  listening,
  children,
}: {
  /** Bound to whether the board itself is reachable — never hardcoded. */
  listening: boolean;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.brand[600],
        padding: space.xl,
        marginBottom: space.xl,
        overflow: 'hidden',
      }}
    >
      {/* [FOUNDER VETO] A watermark of the `orders` pictogram was built here and
          PULLED after seeing it on device: that glyph is a receipt, and at 132px
          its sawtooth hem reads as exactly the toothed ornament the founder
          vetoed — "the veto generalises: no toothed ornament anywhere". The card
          carries its weight from the maroon ground, the display face and three
          live rows; it does not need the texture. Restoring it is one line if
          the veto is judged not to reach a 10%-opacity watermark. */}

      <T variant="micro" weight="bold" tone="onBrand" style={{ letterSpacing: 1.1, opacity: 0.78 }}>
        YOUR FIRST ORDER
      </T>
      <T variant="title" tone="onBrand" style={{ marginTop: space.xs }}>
        The board is live.
      </T>
      <T variant="body" tone="onBrand" style={{ marginTop: space.sm, opacity: 0.88 }}>
        Orders land here the second they&apos;re placed, with a sound you can&apos;t miss. These bring the
        first one sooner:
      </T>

      <View style={{ gap: space.sm, marginTop: space.lg }}>{children}</View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg }}>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: radius.full,
            backgroundColor: listening ? color.success : color.warning,
          }}
        />
        <T variant="micro" weight="semibold" tone="onBrand" style={{ letterSpacing: 0.9, opacity: 0.85 }}>
          {listening ? 'LISTENING FOR ORDERS' : 'RECONNECTING TO THE BOARD'}
        </T>
      </View>
    </View>
  );
}
