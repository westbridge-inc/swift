import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space, withAlpha } from '@swift/ui';
import { T, cardShadow } from '../../kit';

/**
 * The earner DASHBOARD KIT — the surface language of the mover cockpit.
 *
 * [F-270 · RESOLVED] The audit asked: a real dark set, or drop the pretense?
 * The pretense is dropped, because the founder already answered the palette
 * question on 2026-07-16: the earner app wears SWIFT's own palette — light,
 * with the brand red — and there is NO second dark identity to maintain.
 *
 * What was left was a lie in the code rather than on the screen: a module
 * called `dark.tsx` exporting light-surface tokens, which read to every
 * reviewer (twice now) as a broken dark theme. The file is `surface.tsx`, and
 * `dk` / the `D*` components stand for DASHBOARD, not dark. Nothing about the
 * rendered UI changed here — only the code stopped misdescribing itself.
 *
 * If a dark earner cockpit is ever wanted, it is a FOUNDER decision that
 * starts with a real token ramp, not by re-aliasing these.
 */
export { withAlpha } from '@swift/ui';

export const dk = {
  bg: color.surface.subtle,
  card: color.surface.base,
  cardSoft: color.brand[50],
  line: color.border.subtle,
  text: color.text.primary,
  muted: color.text.muted,
  faint: color.text.muted,
  accent: color.brand[500],
  /** Brand tints for glows, badges and banner fills — always off the token ramp. */
  accentGlow: withAlpha(color.brand[500], 0.25),
  accentSoft: withAlpha(color.brand[500], 0.16),
  accentBorder: withAlpha(color.brand[500], 0.45),
  success: color.success,
  warning: color.warning,
} as const;

/** Arm's-length opportunity signal for an offline mover. */
export function DemandBand({
  count,
  label,
  onPress,
  disabled = false,
  style,
}: {
  count: number;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  if (!Number.isFinite(count) || count <= 0) return null;

  const action = 'Go online to take them';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count} ${label}. ${action}`}
      accessibilityHint="Checks location access before making you available for nearby work"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
    >
      {({ pressed }) => (
        <View
          style={[
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: dk.accentBorder,
              backgroundColor: dk.accentSoft,
              padding: space.lg,
            },
            style,
            { opacity: pressed || disabled ? 0.75 : 1 },
          ]}
        >
          <T variant="displayXl" numberOfLines={1} style={{ color: dk.accent }}>
            {count}
          </T>
          <T variant="body" weight="semibold" style={{ flex: 1, color: dk.text }}>
            {label}.{' '}
            <T variant="bodyStrong" style={{ color: dk.accent }}>
              {action}
            </T>
          </T>
          <Feather name="arrow-right" size={20} color={dk.accent} />
        </View>
      )}
    </Pressable>
  );
}

export function DCard({ style, children }: { style?: ViewStyle; children: React.ReactNode }) {
  return (
    <View style={[{ backgroundColor: dk.card, borderRadius: radius.lg, borderWidth: 1, borderColor: dk.line, padding: space.lg }, cardShadow, style]}>
      {children}
    </View>
  );
}

/** Stat chip: value on top, label under, optional icon. */
export function DStat({
  icon,
  value,
  label,
  flex = 1,
}: {
  icon?: React.ComponentProps<typeof Feather>['name'];
  value: string;
  label: string;
  flex?: number;
}) {
  return (
    <View style={{ flex, backgroundColor: dk.cardSoft, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.md, alignItems: 'center' }}>
      {icon ? <Feather name={icon} size={14} color={color.brand[600]} style={{ marginBottom: 2 }} /> : null}
      <T variant="body" weight="bold" numberOfLines={1} style={{ color: dk.text }}>
        {value}
      </T>
      <T variant="caption" numberOfLines={1} style={{ color: dk.muted, marginTop: 1 }}>
        {label}
      </T>
    </View>
  );
}

/** Screen header: centered title + optional back chevron. */
export function DHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View style={{ height: 52, alignItems: 'center', justifyContent: 'center' }}>
      {/* The 36dp chip plus 10dp hitSlop on every side is a 56dp effective touch target. */}
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} style={{ position: 'absolute', left: space.lg }}>
          {({ pressed }) => (
            <View style={[{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.card, borderWidth: 1, borderColor: dk.line, opacity: pressed ? 0.7 : 1 }, cardShadow]}>
              <Feather name="chevron-left" size={20} color={dk.text} />
            </View>
          )}
        </Pressable>
      ) : null}
      <T variant="heading" style={{ color: dk.text }}>
        {title}
      </T>
    </View>
  );
}

/** Settings row (Feather icon + label + sub + right slot). */
export function DRow({
  icon,
  label,
  sub,
  right,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress}>
      {({ pressed }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.md, opacity: pressed ? 0.7 : 1 }}>
          <View style={{ width: 34, height: 34, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.cardSoft }}>
            <Feather name={icon} size={15} color={color.brand[600]} />
          </View>
          <View style={{ flex: 1, marginLeft: space.md }}>
            <T variant="label" weight="semibold" style={{ color: dk.text }}>
              {label}
            </T>
            {sub ? (
              <T variant="caption" numberOfLines={1} style={{ color: dk.muted, marginTop: 1 }}>
                {sub}
              </T>
            ) : null}
          </View>
          {right ?? (onPress ? <Feather name="chevron-right" size={16} color={dk.muted} /> : null)}
        </View>
      )}
    </Pressable>
  );
}

/** 7-day earnings bars — brand tints on the light surface. */
export function DWeekBars({ days }: { days: Array<{ label: string; total: number; isToday: boolean }> }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, height: 92 }}>
      {days.map((d, i) => {
        const h = Math.max(6, Math.round((d.total / max) * 64));
        return (
          <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
            {d.total > 0 ? (
              <T variant="micro" numberOfLines={1} style={{ color: d.isToday ? dk.text : dk.muted, marginBottom: space.xs }}>
                {d.total >= 1000 ? `${Math.round(d.total / 1000)}k` : String(Math.round(d.total))}
              </T>
            ) : null}
            <View
              style={{
                alignSelf: 'stretch',
                height: h,
                borderRadius: radius.md,
                backgroundColor: d.isToday ? dk.accent : dk.accentSoft,
              }}
            />
            <T variant="micro" style={{ color: d.isToday ? dk.text : dk.muted, marginTop: space.xs }}>
              {d.label}
            </T>
          </View>
        );
      })}
    </View>
  );
}
