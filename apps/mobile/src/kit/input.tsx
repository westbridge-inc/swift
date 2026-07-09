/** @jsxImportSource react */
import React, { useState } from 'react';
import { TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { T } from './text';

/** Kit input: label above, rounded-full outline field, leading icon, right slot.
 *  Focus ring = brand; error state = danger border + caption (never color alone). */
export function LabeledInput({
  label,
  icon,
  right,
  error,
  containerStyle,
  ...input
}: TextInputProps & {
  label?: string;
  icon?: React.ComponentProps<typeof Feather>['name'];
  right?: React.ReactNode;
  error?: string;
  containerStyle?: ViewStyle;
}) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? color.error : focused ? color.brand[500] : color.border.subtle;
  return (
    <View style={containerStyle}>
      {label ? (
        <T variant="label" weight="medium" style={{ marginBottom: space.sm }}>
          {label}
        </T>
      ) : null}
      <View
        style={{
          height: 56,
          borderRadius: 9999,
          borderWidth: 1,
          borderColor,
          backgroundColor: color.surface.base,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: space.xl,
          gap: space.md,
        }}
      >
        {icon ? <Feather name={icon} size={18} color={color.text.muted} /> : null}
        <TextInput
          {...input}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          placeholderTextColor={color.text.muted}
          style={[
            { flex: 1, fontFamily: 'Inter', fontSize: 16, color: color.text.primary, paddingVertical: 0 },
            input.style,
          ]}
        />
        {right}
      </View>
      {error ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm, paddingLeft: space.lg }}>
          <Feather name="alert-circle" size={13} color={color.error} />
          <T variant="caption" tone="error">
            {error}
          </T>
        </View>
      ) : null}
    </View>
  );
}
