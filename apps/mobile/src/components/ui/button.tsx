import { ActivityIndicator, Text as RNText, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { color } from '@swift/ui';
import { cn } from './cn';
import { PressableScale } from './pressable-scale';

type Props = PressableProps & {
  className?: string;
  textClassName?: string;
  variant?: 'solid' | 'outline' | 'neutral';
  label?: string;
  children?: ReactNode;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Primary action — solid Swift red, brand outline, or neutral (quiet secondary:
 *  cancels and back-outs that must not compete with the main action). Press-scales
 *  (motion tokens) and shows a spinner while `loading` (which also disables it). */
export function Button({ className, textClassName, variant = 'solid', label, children, disabled, loading, style, ...props }: Props) {
  const isDisabled = disabled || loading;
  // Loading keeps the active (brand) look — it's working, not disabled. A truly
  // disabled button goes neutral grey (never a washed-out tint of the brand red).
  const inactive = disabled && !loading;
  const solid = variant === 'solid';
  const neutral = variant === 'neutral';
  // Brand fills are inline style: class-based brand colors silently render
  // BLACK at runtime (NativeWind class materialization — sim-verified), and a
  // CTA is too load-bearing to risk.
  const variantClass = solid
    ? (inactive ? 'bg-border-strong' : '')
    : (inactive ? 'border border-border-subtle bg-white' : 'border bg-white');
  const variantStyle = solid
    ? (inactive ? undefined : { backgroundColor: color.brand[500] })
    : (inactive ? undefined : { borderColor: neutral ? color.border.strong : color.brand[500] });
  const textColor = solid ? 'text-white' : (inactive ? 'text-text-muted' : '');
  const textStyle = !solid && !inactive
    ? { color: neutral ? color.text.primary : color.brand[500] }
    : undefined;
  return (
    <PressableScale
      disabled={isDisabled}
      className={cn('flex-row items-center justify-center rounded-full px-5 py-3.5', variantClass, className)}
      style={[variantStyle, style]}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={solid ? color.white : neutral ? color.text.secondary : color.brand[500]} />
      ) : label ? (
        <RNText className={cn('font-body text-base font-semibold', textColor, textClassName)} style={textStyle}>{label}</RNText>
      ) : (
        children
      )}
    </PressableScale>
  );
}
