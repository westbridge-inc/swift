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

/** Owned text field on @swift/ui tokens, with icon slots. Kit field spec:
 *  white surface, hairline border, r8, 52px tall. */
export function Input({ className, containerClassName, left, right, ...props }: Props) {
  return (
    <View
      className={cn(
        'flex-row items-center border border-border-subtle bg-surface-base px-lg',
        containerClassName,
      )}
      style={{ borderRadius: 8 }}
    >
      {left}
      <TextInput
        placeholderTextColor={color.text.muted}
        className={cn('flex-1 font-body text-base text-text-primary', className)}
        style={{ paddingVertical: 14 }}
        {...props}
      />
      {right}
    </View>
  );
}
