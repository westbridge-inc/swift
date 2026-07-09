/** @jsxImportSource react */
import React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { color, fontSize, lineHeight } from '@swift/ui';

// RN selects fonts by family name, so each Inter weight is its own family
// (registered in App.tsx). Never set fontWeight — always a family.
const FAMILY = {
  regular: 'Inter',
  medium: 'InterMedium',
  semibold: 'InterSemiBold',
  bold: 'InterBold',
} as const;

type Weight = keyof typeof FAMILY;

// The kit's type roles: display = masthead heroes, title = screen titles,
// heading = section titles, body = copy, label = buttons/meta, caption = fine print.
const VARIANT: Record<string, TextStyle> = {
  display: { fontSize: fontSize['3xl'], lineHeight: lineHeight['3xl'], fontFamily: FAMILY.bold },
  title: { fontSize: fontSize['2xl'], lineHeight: lineHeight['2xl'], fontFamily: FAMILY.bold },
  heading: { fontSize: fontSize.lg, lineHeight: lineHeight.lg, fontFamily: FAMILY.semibold },
  body: { fontSize: fontSize.base, lineHeight: lineHeight.base, fontFamily: FAMILY.regular },
  label: { fontSize: fontSize.sm, lineHeight: lineHeight.sm, fontFamily: FAMILY.medium },
  caption: { fontSize: fontSize.xs, lineHeight: lineHeight.xs, fontFamily: FAMILY.regular },
};

const TONE = {
  ink: color.text.primary,
  muted: color.text.secondary,
  faint: color.text.muted,
  brand: color.brand[500],
  deep: color.brand[600],
  onBrand: color.text.onBrand,
  success: color.success,
  error: color.error,
  star: color.warning,
} as const;

export interface TTone {
  tone?: keyof typeof TONE;
}

export interface TP extends TextProps, TTone {
  variant?: keyof typeof VARIANT;
  weight?: Weight;
  center?: boolean;
}

export function T({ variant = 'body', tone = 'ink', weight, center, style, ...rest }: TP) {
  return (
    <RNText
      {...rest}
      style={[
        VARIANT[variant],
        { color: TONE[tone] },
        weight ? { fontFamily: FAMILY[weight] } : null,
        center ? { textAlign: 'center' } : null,
        style,
      ]}
    />
  );
}
