import { ActivityIndicator, Text as RNText, type PressableProps } from 'react-native';
import type { ReactNode } from 'react';
import { color } from '@swift/ui';
import { cn } from './cn';
import { PressableScale } from './pressable-scale';

type Props = PressableProps & {
  className?: string;
  textClassName?: string;
  variant?: 'solid' | 'outline';
  label?: string;
  children?: ReactNode;
  loading?: boolean;
};

/** Primary action — solid Swift red or outline. Press-scales (motion tokens) and
 *  shows a spinner while `loading` (which also disables it). */
export function Button({ className, textClassName, variant = 'solid', label, children, disabled, loading, ...props }: Props) {
  const isDisabled = disabled || loading;
  // Loading keeps the active (brand) look — it's working, not disabled. A truly
  // disabled button goes neutral grey (never a washed-out tint of the brand red).
  const inactive = disabled && !loading;
  const solid = variant === 'solid';
  const variantClass = solid
    ? (inactive ? 'bg-border-strong' : 'bg-brand-500 active:bg-brand-600')
    : (inactive ? 'border border-border-subtle bg-white' : 'border border-brand-500 bg-white active:bg-brand-50');
  const textColor = solid ? 'text-white' : (inactive ? 'text-text-muted' : 'text-brand-500');
  return (
    <PressableScale
      disabled={isDisabled}
      className={cn('flex-row items-center justify-center rounded-lg px-4 py-3', variantClass, className)}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'solid' ? '#fff' : color.brand[500]} />
      ) : label ? (
        <RNText className={cn('font-body text-base font-semibold', textColor, textClassName)}>{label}</RNText>
      ) : (
        children
      )}
    </PressableScale>
  );
}
