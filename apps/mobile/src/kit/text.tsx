/** @jsxImportSource react */
import React from 'react';
import { StyleSheet, Text as RNText, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';
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
/**
 * TOTAL over `typeScale`, and that is the point of the annotation.
 *
 * This was `Record<string, TextStyle>`, which means `keyof typeof VARIANT` is
 * just `string` — so `variant` accepted ANY string. `<T variant="titel">` (a
 * typo) compiled cleanly and then crashed at render, because line ~83 forces
 * the lookup through a non-null assertion and `scaleLineHeight` dereferences
 * `.lineHeight` on `undefined`. A TypeError, in production, from a typo the
 * compiler was in a position to catch. Verified before changing it: tsc
 * accepted `variant="thisStepDoesNotExist"` without complaint.
 *
 * `Record<keyof typeof typeScale, TextStyle>` fixes both directions at once:
 *   - a name that is not a step is now a BUILD error, not a render crash;
 *   - a step added to tokens.ts and forgotten here is ALSO a build error,
 *     because the record would no longer be total.
 *
 * That second direction is the load-bearing one. The type scale is written out
 * by hand in four separate places, and this is the copy whose omission fails
 * loudest and latest. Making it exhaustive means the next person to add a step
 * cannot ship the crash — the build stops them.
 */
const VARIANT: Record<keyof typeof typeScale, TextStyle> = {
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

/** Exported for the exhaustiveness test only — the runtime half of the guard
 *  above, so the rule survives someone widening the annotation back. */
export const TYPE_VARIANTS = Object.keys(VARIANT) as (keyof typeof VARIANT)[];

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
// Typed against the variant union for the same reason as VARIANT: a display
// step misspelled here silently loses face integrity — a `weight` override
// would swap Bricolage for Hanken, and Hanken carries no `tnum`, so money
// quietly stops being tabular. A build error is a much cheaper way to find out.
const DISPLAY_FACE = new Set<keyof typeof VARIANT>(['displayXl', 'display', 'title', 'numL', 'numM']);

/** [F-027-05] A caller's own lineHeight still has to scale. */
function scaleCallerLineHeight(style: TP['style'], fontScale: number): TP['style'] {
  if (!style || fontScale === 1) return style;
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  if (!flat?.lineHeight) return style;
  return scaleLineHeight(flat, fontScale);
}

export function T({ variant = 'body', tone = 'ink', weight, center, style, ...rest }: TP) {
  // useWindowDimensions (not PixelRatio.getFontScale) so a font-scale change
  // while the app is open re-renders instead of keeping a stale box.
  const { fontScale } = useWindowDimensions();
  return (
    <RNText
      {...rest}
      style={[
        // No `!` needed now: the record is total over the variant union.
        scaleLineHeight(VARIANT[variant], fontScale),
        { color: TONE[tone] },
        weight && !DISPLAY_FACE.has(variant) ? { fontFamily: FAMILY[weight] } : null,
        center ? { textAlign: 'center' } : null,
        // [F-027-05] Caller style comes LAST, which is correct for
        // precedence — and meant any caller that set an explicit lineHeight
        // silently reinstated an UNSCALED one, overriding the scaled token.
        // Scale theirs too, so overriding the value does not opt out of
        // Dynamic Type.
        scaleCallerLineHeight(style, fontScale),
      ]}
    />
  );
}
