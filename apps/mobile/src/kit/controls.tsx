/** @jsxImportSource react */
import React from 'react';
import { Pressable, Switch, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { cardShadow } from './card';
import { haptic } from '../lib/haptics';
import { HeartGlyph, StarGlyph } from './glyphs';
import { T } from './text';

function RoundIconButton({
  icon,
  onPress,
  disabled = false,
  size = 32,
  label,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  onPress?: () => void;
  disabled?: boolean;
  size?: number;
  label?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label ?? icon.replace(/-/g, ' ')}
      accessibilityState={{ disabled }}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {({ pressed }) => (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1,
            borderColor: color.border.strong,
            backgroundColor: pressed ? color.brand[50] : color.surface.base,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name={icon} size={size * 0.5} color={color.text.primary} />
        </View>
      )}
    </Pressable>
  );
}

/** Kit quantity stepper: outlined round − / +, count between. */
export function QtyStepper({
  value,
  onDec,
  onInc,
  min = 0,
}: {
  value: number;
  onDec: () => void;
  onInc: () => void;
  min?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <RoundIconButton icon="minus" onPress={onDec} disabled={value <= min} label="Decrease quantity" />
      <T weight="semibold" style={{ minWidth: 20, textAlign: 'center' }}>
        {value}
      </T>
      <RoundIconButton icon="plus" onPress={onInc} label="Increase quantity" />
    </View>
  );
}

/** Kit rounded-square checkbox (cart row selection). */
export function BrandCheckbox({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label?: string }) {
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityLabel={label ?? 'Select item'}
      accessibilityState={{ checked }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 8,
          backgroundColor: checked ? color.brand[500] : color.border.subtle,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Feather name="check" size={15} color={color.white} /> : null}
      </View>
    </Pressable>
  );
}

/** Floating heart chip over imagery. */
export function HeartBadge({
  active,
  onPress,
  size = 36,
}: {
  active: boolean;
  onPress?: () => void;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Remove from favourites' : 'Add to favourites'}
      accessibilityState={{ selected: active }}
    >
      <View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color.surface.base,
            alignItems: 'center',
            justifyContent: 'center',
          },
          cardShadow,
        ]}
      >
        <HeartGlyph
          size={size * 0.55}
          filled={active}
          color={active ? color.brand[500] : color.text.muted}
        />
      </View>
    </Pressable>
  );
}

/** Star row — the `star` rating hue (decorative; never carries meaning alone).
 *  Pass `onRate` to make it an input. */
export function Stars({
  value,
  size = 14,
  gap = 2,
  onRate,
}: {
  value: number;
  size?: number;
  gap?: number;
  onRate?: (n: number) => void;
}) {
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap }}
      accessibilityLabel={onRate ? undefined : `Rated ${value} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const star = <StarGlyph size={size} filled={n <= Math.round(value)} color={color.star} />;
        return onRate ? (
          <Pressable
            key={n}
            hitSlop={6}
            onPress={() => onRate(n)}
            accessibilityRole="button"
            accessibilityLabel={`Rate ${n} out of 5 stars`}
            accessibilityState={{ selected: n <= Math.round(value) }}
          >
            <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>{star}</View>
          </Pressable>
        ) : (
          <View key={n}>{star}</View>
        );
      })}
    </View>
  );
}

/** Pill chip — categories, filters, sort options.
 *  `emoji` is DEPRECATED (design-100× Part 14: emoji are never UI icons) —
 *  remaining passers lose it as their flow is elevated; then the prop dies. */
export function Chip({
  label,
  emoji,
  selected = false,
  onPress,
  style,
}: {
  label: string;
  emoji?: string;
  selected?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      onPress={
        onPress
          ? () => {
              haptic.select();
              onPress();
            }
          : undefined
      }
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
    >
      {({ pressed }) => (
        <View
          style={[
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              paddingHorizontal: space.xl,
              height: 48,
              borderRadius: 9999,
              backgroundColor: selected ? color.brand[500] : color.surface.base,
              borderWidth: 1,
              borderColor: selected ? color.brand[500] : color.border.subtle,
              opacity: pressed ? 0.75 : 1,
            },
            style,
          ]}
        >
          {emoji ? <T variant="body">{emoji}</T> : null}
          <T variant="label" weight={selected ? 'semibold' : 'medium'} tone={selected ? 'onBrand' : 'ink'}>
            {label}
          </T>
        </View>
      )}
    </Pressable>
  );
}

/** Soft status pill — order/job states. Tint per tone, never color alone. */
export function TonePill({ label, tone = 'neutral', dark }: { label: string; tone?: 'brand' | 'success' | 'neutral' | 'error'; dark?: boolean }) {
  const c = (dark
    ? {
        brand: { bg: 'rgba(128,59,59,0.35)', fg: '#E9B9B9' },
        success: { bg: 'rgba(47,191,113,0.18)', fg: '#5AD695' },
        error: { bg: 'rgba(224,82,82,0.2)', fg: '#F09A9A' },
        neutral: { bg: 'rgba(255,255,255,0.1)', fg: 'rgba(255,255,255,0.7)' },
      }
    : {
        brand: { bg: color.brand[50], fg: color.brand[600] },
        success: { bg: color.soft.success, fg: color.success },
        error: { bg: color.soft.danger, fg: color.error },
        neutral: { bg: color.border.subtle, fg: color.text.secondary },
      })[tone];
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: 5, borderRadius: 9999, backgroundColor: c.bg, alignSelf: 'flex-start' }}>
      <T variant="caption" weight="semibold" style={{ color: c.fg }}>
        {label}
      </T>
    </View>
  );
}

/** Brand-tracked switch (settings rows). */
export function BrandSwitch({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      trackColor={{ true: color.brand[500], false: color.border.subtle }}
      thumbColor={color.white}
    />
  );
}
