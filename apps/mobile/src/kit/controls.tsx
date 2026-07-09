/** @jsxImportSource react */
import React from 'react';
import { Pressable, Switch, View, type ViewStyle } from 'react-native';
import { Feather, Ionicons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { cardShadow } from './card';
import { T } from './text';

function RoundIconButton({
  icon,
  onPress,
  disabled = false,
  size = 32,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  onPress?: () => void;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6} style={{ opacity: disabled ? 0.4 : 1 }}>
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
      <RoundIconButton icon="minus" onPress={onDec} disabled={value <= min} />
      <T weight="semibold" style={{ minWidth: 20, textAlign: 'center' }}>
        {value}
      </T>
      <RoundIconButton icon="plus" onPress={onInc} />
    </View>
  );
}

/** Kit rounded-square checkbox (cart row selection). */
export function BrandCheckbox({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <Pressable onPress={onToggle} hitSlop={8}>
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
    <Pressable onPress={onPress} hitSlop={8}>
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
        <Ionicons
          name={active ? 'heart' : 'heart-outline'}
          size={size * 0.55}
          color={active ? color.brand[500] : color.text.muted}
        />
      </View>
    </Pressable>
  );
}

/** Star row — amber per the token discipline (warning doubles as rating hue).
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const star = (
          <Ionicons
            name={n <= Math.round(value) ? 'star' : 'star-outline'}
            size={size}
            color={color.warning}
          />
        );
        return onRate ? (
          <Pressable key={n} hitSlop={6} onPress={() => onRate(n)}>
            <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>{star}</View>
          </Pressable>
        ) : (
          <View key={n}>{star}</View>
        );
      })}
    </View>
  );
}

/** Pill chip — categories, filters, sort options. */
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
    <Pressable onPress={onPress}>
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
              backgroundColor: selected ? color.brand[50] : color.surface.base,
              borderWidth: 1,
              borderColor: selected ? color.brand[500] : color.border.subtle,
              opacity: pressed ? 0.75 : 1,
            },
            style,
          ]}
        >
          {emoji ? <T variant="body">{emoji}</T> : null}
          <T variant="label" weight={selected ? 'semibold' : 'medium'} tone={selected ? 'deep' : 'ink'}>
            {label}
          </T>
        </View>
      )}
    </Pressable>
  );
}

/** Brand-tracked switch (settings rows). */
export function BrandSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ true: color.brand[500], false: color.border.subtle }}
      thumbColor={color.white}
    />
  );
}
