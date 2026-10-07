import type { ViewStyle } from 'react-native';

/**
 * [ANDROID-QA] A 48dp touch box around a small control, without moving it.
 *
 * Android's accessibility tools (and Google Play's pre-launch report) measure
 * a control's OWN bounds. `hitSlop` widens where a finger lands, but those
 * tools never see it, so a 22dp bell with hitSlop still reports as a 22dp
 * target. This grows the pressable itself to 48dp and cancels the growth with
 * an equal negative margin, so the layout and the glyph stay exactly where
 * they were.
 */
export const MIN_TOUCH_DP = 48;

export function touchTarget(visualSize: number): ViewStyle {
  const grow = Math.max(0, (MIN_TOUCH_DP - visualSize) / 2);
  return {
    minWidth: MIN_TOUCH_DP,
    minHeight: MIN_TOUCH_DP,
    margin: -grow,
    alignItems: 'center',
    justifyContent: 'center',
  };
}
