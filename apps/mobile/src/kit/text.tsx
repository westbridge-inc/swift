/** @jsxImportSource react */
import React from 'react';
import { Text as RNText, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';
import { color, font, typeScale } from '@swift/ui';
import { scaleLineHeight } from './text-scale';

// RN selects fonts by family name, so each weight is its own family
// (registered in App.tsx). Never set fontWeight — always a family.
// Bricolage Grotesque = display + tabular numbers; Hanken Grotesk = body.
const FAMILY = {
  regular: font.body,
  medium: font.bodyMedium,
  semibold: font.bodySemiBold,
  bold: font.bodyBold,
} as const;

type Weight = keyof typeof FAMILY;

// The kit's type roles ride the Design-100× scale (tokens.typeScale):
// display/displayXl = masthead heroes + the big moments (countdown, PIN),
// title = screen/section titles, heading = card titles, body = copy,
// bodyStrong = inline emphasis + button labels, label = meta/small buttons,
// caption = fine print, micro = eyebrows/badges (caps), numL/numM = money —
// ALWAYS tabular, always the display face.
const VARIANT: Record<string, TextStyle> = {
  displayXl: typeScale.displayXl as TextStyle,
  display: typeScale.display as TextStyle,
  title: typeScale.title as TextStyle,
  heading: typeScale.heading as TextStyle,
  body: typeScale.body as TextStyle,
  bodyStrong: typeScale.bodyStrong as TextStyle,
  label: typeScale.label as TextStyle,
  caption: typeScale.caption as TextStyle,
  micro: typeScale.micro as TextStyle,
  numL: typeScale.numL as TextStyle,
  numM: typeScale.numM as TextStyle,
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
  warning: color.warning,
  info: color.info,
  star: color.star,
} as const;

export interface TTone {
  tone?: keyof typeof TONE;
}

export interface TP extends TextProps, TTone {
  variant?: keyof typeof VARIANT;
  weight?: Weight;
  center?: boolean;
}

// Display/num variants own their face — a `weight` override only ever picks a
// body-face weight, so it is ignored on these (face integrity beats the prop).
const DISPLAY_FACE = new Set(['displayXl', 'display', 'title', 'numL', 'numM']);

export function T({ variant = 'body', tone = 'ink', weight, center, style, ...rest }: TP) {
  // useWindowDimensions (not PixelRatio.getFontScale) so a font-scale change
  // while the app is open re-renders instead of keeping a stale box.
  const { fontScale } = useWindowDimensions();
  return (
    <RNText
      {...rest}
      style={[
        scaleLineHeight(VARIANT[variant]!, fontScale),
        { color: TONE[tone] },
        weight && !DISPLAY_FACE.has(variant) ? { fontFamily: FAMILY[weight] } : null,
        center ? { textAlign: 'center' } : null,
        style,
      ]}
    />
  );
}
