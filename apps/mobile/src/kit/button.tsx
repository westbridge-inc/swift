/** @jsxImportSource react */
import React from 'react';
import { ActivityIndicator, Pressable, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { T } from './text';

const HEIGHT = { lg: 56, md: 48, sm: 38 } as const;

type Variant = 'primary' | 'soft' | 'dark' | 'outline' | 'destructive';
type Size = keyof typeof HEIGHT;

const BG: Record<Variant, { rest: string; pressed: string; label: string; border?: string }> = {
  primary: { rest: color.brand[500], pressed: color.brand[600], label: color.text.onBrand },
  // The kit's neutral-gray pills become the brand-soft tint under Indian Red.
  soft: { rest: color.brand[50], pressed: color.brand[100], label: color.brand[600] },
  dark: { rest: color.text.primary, pressed: '#3A2F2F', label: color.white },
  outline: { rest: color.surface.base, pressed: color.brand[50], label: color.text.primary, border: color.border.subtle },
  // Part 12: destructive = danger fill + REQUIRED icon at the call site —
  // never colour alone. Brand never signals an error (two-reds law).
  destructive: { rest: color.error, pressed: color.errorDeep, label: color.text.onBrand },
};

/** The kit's pill CTA. Full-radius, three tiers, optional leading icon. */
export function PillButton({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  icon,
  loading = false,
  disabled = false,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  icon?: React.ComponentProps<typeof Feather>['name'];
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const v = BG[variant];
  const blocked = disabled || loading;
  return (
    <Pressable
      onPress={blocked ? undefined : onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      style={{ opacity: disabled ? 0.45 : 1, ...(style as object) }}
    >
      {({ pressed }) => (
        <View
          style={{
            height: HEIGHT[size],
            borderRadius: 9999,
            paddingHorizontal: size === 'sm' ? space.lg : space['2xl'],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: space.sm,
            backgroundColor: pressed ? v.pressed : v.rest,
            borderWidth: v.border ? 1 : 0,
            borderColor: v.border,
          }}
        >
          {loading ? (
            <ActivityIndicator size="small" color={v.label} />
          ) : (
            <>
              {icon ? <Feather name={icon} size={size === 'sm' ? 15 : 18} color={v.label} /> : null}
              <T
                variant={size === 'sm' ? 'label' : 'body'}
                weight="semibold"
                style={{ color: v.label }}
              >
                {label}
              </T>
            </>
          )}
        </View>
      )}
    </Pressable>
  );
}

/** Bare inline text action — “See All”, “Forgot password?”. */
export function LinkText({ label, onPress, tone = 'brand' as const }: { label: string; onPress?: () => void; tone?: 'brand' | 'muted' }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}>
      {({ pressed }) => (
        <View style={{ opacity: pressed ? 0.6 : 1 }}>
          <T variant="label" tone={tone} weight="medium">
            {label}
          </T>
        </View>
      )}
    </Pressable>
  );
}
