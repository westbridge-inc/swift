import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { T, cardShadow } from '../../kit';

/**
 * The earner dashboard's surface language — SWIFT's own palette (founder
 * decision 2026-07-16: the earner app matches the rest of Swift — light with
 * the brand red; no second dark identity). The `dk` name survives from the
 * earlier dark iteration so the screens read unchanged.
 */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

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

export function DCard({ style, children }: { style?: ViewStyle; children: React.ReactNode }) {
  return (
    <View style={[{ backgroundColor: dk.card, borderRadius: 16, borderWidth: 1, borderColor: dk.line, padding: 16 }, cardShadow, style]}>
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
    <View style={{ flex, backgroundColor: dk.cardSoft, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center' }}>
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
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} style={{ position: 'absolute', left: 16 }}>
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
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, opacity: pressed ? 0.7 : 1 }}>
          <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.cardSoft }}>
            <Feather name={icon} size={15} color={color.brand[600]} />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
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
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 92 }}>
      {days.map((d, i) => {
        const h = Math.max(6, Math.round((d.total / max) * 64));
        return (
          <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
            {d.total > 0 ? (
              <T variant="caption" numberOfLines={1} style={{ color: d.isToday ? dk.text : dk.muted, fontSize: 9, marginBottom: 3 }}>
                {d.total >= 1000 ? `${Math.round(d.total / 1000)}k` : String(Math.round(d.total))}
              </T>
            ) : null}
            <View
              style={{
                alignSelf: 'stretch',
                height: h,
                borderRadius: 6,
                backgroundColor: d.isToday ? dk.accent : dk.accentSoft,
              }}
            />
            <T variant="caption" style={{ color: d.isToday ? dk.text : dk.muted, fontSize: 10, marginTop: 4 }}>
              {d.label}
            </T>
          </View>
        );
      })}
    </View>
  );
}
