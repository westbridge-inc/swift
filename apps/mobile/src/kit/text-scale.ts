import type { TextStyle } from 'react-native';

/**
 * [F-241] Every type token carries an ABSOLUTE lineHeight (packages/ui
 * tokens.ts). React Native scales `fontSize` by the OS font scale but leaves a
 * style-declared `lineHeight` untouched, so at 1.3x a 34pt displayXl glyph
 * (rendered at 44pt) is laid into a 38pt box and clips — on the OTP digits,
 * the pickup code and hero money.
 *
 * Growing the box by the same factor preserves the designed leading ratio at
 * every accessibility setting. At fontScale 1 this returns the original style
 * object untouched, so shipping the fix changes nothing at default settings.
 *
 * Pure on purpose: the kit's Text component is JSX, and the suite runs in a
 * node environment — keeping the arithmetic here is what makes it testable.
 */
export function scaleLineHeight(base: TextStyle, fontScale: number): TextStyle {
  if (!base.lineHeight || fontScale === 1) return base;
  return { ...base, lineHeight: base.lineHeight * fontScale };
}
