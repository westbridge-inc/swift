import { Pressable, Text as RNText, type PressableProps } from 'react-native';
import type { ReactNode } from 'react';
import { cn } from './cn';

type Props = PressableProps & {
  className?: string;
  textClassName?: string;
  variant?: 'solid' | 'outline';
  label?: string;
  children?: ReactNode;
};

/** Primary action — solid Swift red, or outline. */
export function Button({ className, textClassName, variant = 'solid', label, children, ...props }: Props) {
  const variantClass = variant === 'solid' ? 'bg-brand-500 active:bg-brand-600' : 'border border-brand-500 bg-white active:bg-brand-50';
  const textColor = variant === 'solid' ? 'text-white' : 'text-brand-500';
  return (
    <Pressable className={cn('flex-row items-center justify-center rounded-lg px-4 py-3', variantClass, className)} {...props}>
      {label ? <RNText className={cn('font-body text-base font-semibold', textColor, textClassName)}>{label}</RNText> : children}
    </Pressable>
  );
}
