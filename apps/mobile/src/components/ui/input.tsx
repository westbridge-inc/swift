import { TextInput, View, type TextInputProps } from 'react-native';
import type { ReactNode } from 'react';
import { color } from '@swift/ui';
import { cn } from './cn';

type Props = TextInputProps & {
  className?: string;
  containerClassName?: string;
  /** Slots for leading/trailing adornments (e.g. a search or clear icon). */
  left?: ReactNode;
  right?: ReactNode;
};

/** Owned text field (Gluestack-v3 style) on @swift/ui tokens, with icon slots. */
export function Input({ className, containerClassName, left, right, ...props }: Props) {
  return (
    <View
      className={cn(
        'flex-row items-center rounded-2xl border border-border-subtle bg-surface-subtle px-lg',
        containerClassName,
      )}
    >
      {left}
      <TextInput
        placeholderTextColor={color.text.muted}
        className={cn('flex-1 py-md font-body text-base text-text-primary', className)}
        {...props}
      />
      {right}
    </View>
  );
}
