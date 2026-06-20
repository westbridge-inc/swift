import { TextInput, View, type TextInputProps } from 'react-native';
import { color } from '@swift/ui';
import { Text } from './text';
import { cn } from './cn';

/**
 * A labelled form field with inline validation — label on top, the input, and an
 * error line that turns the border red. The building block for the auth /
 * onboarding flows so they stop being raw, feedback-less TextInputs.
 */
export function Field({
  label,
  error,
  className,
  ...inputProps
}: TextInputProps & { label?: string; error?: string; className?: string }) {
  return (
    <View className="mb-md">
      {label ? <Text className="mb-xs text-sm font-semibold text-text-secondary">{label}</Text> : null}
      <TextInput
        placeholderTextColor={color.text.muted}
        className={cn(
          'rounded-lg border bg-surface-base px-lg py-md font-body text-base text-text-primary',
          error ? 'border-error' : 'border-border-subtle',
          className,
        )}
        {...inputProps}
      />
      {error ? <Text className="mt-xs text-xs text-error">{error}</Text> : null}
    </View>
  );
}
