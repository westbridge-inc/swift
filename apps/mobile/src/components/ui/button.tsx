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
  const variantClass = variant === 'solid' ? 'bg-brand-500 active:bg-brand-600' : 'border border-brand-500 bg-white active:bg-brand-50';
  const textColor = variant === 'solid' ? 'text-white' : 'text-brand-500';
  const isDisabled = disabled || loading;
  return (
    <PressableScale
      disabled={isDisabled}
      className={cn('flex-row items-center justify-center rounded-lg px-4 py-3', variantClass, isDisabled && 'opacity-40', className)}
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
