/** @jsxImportSource react */
import React, { useState } from 'react';
import { TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T } from './text';

/** Kit input — gluestack-grade field: label above, a DEFINED rounded-rectangle
 *  (not a faint pill), a visible resting border that reads as a real control,
 *  a brand focus state, and a danger error state with caption (never colour
 *  alone). Leading icon + right slot supported. This is the single field used
 *  across auth, vendor onboarding and the item editor, so every "enter info"
 *  surface inherits the same weight. */
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
  const borderColor = error ? color.error : focused ? color.brand[500] : color.border.strong;
  return (
    <View style={containerStyle}>
      {label ? (
        <T variant="label" weight="semibold" style={{ marginBottom: space.sm }}>
          {label}
        </T>
      ) : null}
      <View
        style={{
          minHeight: 52,
          borderRadius: radius.md,
          // 1.5 on focus/error so the state reads without shifting layout much.
          borderWidth: focused || error ? 1.5 : 1,
          borderColor,
          backgroundColor: color.surface.base,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: space.lg,
          gap: space.md,
        }}
      >
        {icon ? <Feather name={icon} size={18} color={focused ? color.brand[500] : color.text.muted} /> : null}
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
            { flex: 1, fontFamily: 'Inter', fontSize: 16, color: color.text.primary, paddingVertical: 14 },
            input.style,
          ]}
        />
        {right}
      </View>
      {error ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm, paddingLeft: space.xs }}>
          <Feather name="alert-circle" size={13} color={color.error} />
          <T variant="caption" tone="error">
            {error}
          </T>
        </View>
      ) : null}
    </View>
  );
}
