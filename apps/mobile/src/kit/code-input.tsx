/** @jsxImportSource react */
import React, { useEffect, useRef } from 'react';
import { Pressable, TextInput, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { color, motion, radius, space } from '@swift/ui';
import { T } from './text';

/**
 * [Q6] The narrowest parent any caller gives the code row: a PopupCard on a
 * 320pt phone. 320, less the scrim's space.lg gutter on each side, less the
 * card's space['2xl'] padding on each side, leaves 240pt. The vendor's
 * handover Card (space.lg padding inside the space['2xl'] screen gutter) comes
 * to the same 240.
 */
const NARROWEST_ROW = 320 - 2 * space.lg - 2 * space['2xl'];

/** [Q6] A box's floor at the default text size: a displayXl digit and its
 *  border, with air either side. */
const BOX_FLOOR = 32;

/**
 * The code ceremony (design-100× Part 5 moment 4): PIN / start-code entry as
 * large digit boxes — the active box wears a brand border, digits render in
 * the display face, and a failed verify shakes the row (±6dp ×3, fast) while
 * the digits flush error. One hidden input drives it; the number pad stays.
 */
export function CodeInput({
  value,
  onChange,
  length = 6,
  error = false,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  error?: boolean;
  autoFocus?: boolean;
}) {
  const input = useRef<TextInput>(null);
  const shake = useSharedValue(0);
  // [F-027-05] The digit box has to grow with the digit.
  const { fontScale } = useWindowDimensions();
  // One 1–2× cap for the box's ceiling and its floor: the same 2× the glyph
  // stops at (F-028-18).
  const scale = Math.max(1, Math.min(fontScale, 2));
  // [Q6] THE FLOOR IS WHAT KEEPS SIX BOXES ON THE SCREEN. Each box is
  // `flex: 1` under a ceiling, and without a floor its flex basis is only its
  // border: 4pt for the active box, 2pt for the rest. React Native 0.85's Yoga
  // hands out a row's free space in two passes, and the first divides it by a
  // grow total that it shrinks as boxes hit their ceiling. When the active
  // FIRST box's share tips just past the ceiling, every box after it is judged
  // against a bigger share, all six freeze at the ceiling, the frozen total
  // overshoots the free space, and the second pass (`flex: 1` never shrinks)
  // leaves every box at its border: six thin lines in a full-width row, the
  // moment the code opens. That is a 10pt band of row widths, 343–352pt at the
  // default text size: a PopupCard on a 428/430pt iPhone (the emergency-contact
  // confirm, the money step-up; the vendor's handover card too) and the
  // driver's and rider's PIN sheet on a 393pt iPhone. Larger text moves the
  // band onto other phones. One floor for all six gives every box the same
  // basis, so no box tips first.
  //
  // It grows with the digit, but never past this code's share of the narrowest
  // card, so the row still fits a PopupCard on a 320pt phone at any text size:
  // 6 × 32 + 5 × 8 = 232pt at the default size, at most 6 × 33 + 5 × 8 = 238pt.
  const floor = Math.min(BOX_FLOOR * scale, Math.floor((NARROWEST_ROW - (length - 1) * space.sm) / length));

  useEffect(() => {
    if (error) {
      shake.value = withSequence(
        withTiming(-6, { duration: motion.duration.instant }),
        withTiming(6, { duration: motion.duration.instant }),
        withTiming(-6, { duration: motion.duration.instant }),
        withTiming(6, { duration: motion.duration.instant }),
        withTiming(0, { duration: motion.duration.instant }),
      );
    }
  }, [error, shake]);

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const digits = value.slice(0, length).split('');
  const active = Math.min(digits.length, length - 1);

  // [Q6] The row asks for its width instead of waiting to be given one. In a
  // parent that centres its children (PopupCard's content does), an
  // unstretched tap target is shrink-wrapped and the row with it: six boxes
  // 2–4pt wide in a 54pt row, the confirm popup's shape before #1297. So the
  // tap target and the row both stretch to their parent's full width.
  return (
    <Pressable onPress={() => input.current?.focus()} accessibilityLabel="Code entry" style={{ alignSelf: 'stretch' }}>
      <Animated.View style={[{ flexDirection: 'row', gap: space.sm, justifyContent: 'center', alignSelf: 'stretch' }, row]}>
        {Array.from({ length }, (_, i) => {
          const filled = i < digits.length;
          const isActive = i === active && digits.length < length;
          return (
            <View
              key={i}
              style={{
                flex: 1,
                // [F-027-05] The box must grow with the text inside it. A
                // fixed 60dp height clipped the digit at the 2x Dynamic Type
                // the F-241 test itself exercises — displayXl's 38dp line box
                // becomes 76dp — and this is the OTP/PIN input, so clipping it
                // is not a cosmetic defect: it is the door to the account.
                maxWidth: 52 * scale,
                // [Q6] ...and the shared floor (above), so neither a parent nor
                // Yoga's flex passes can squeeze a box down to its border.
                minWidth: floor,
                minHeight: 60,
                paddingVertical: space.xs,
                borderRadius: radius.md,
                borderWidth: isActive ? 2 : 1,
                borderColor: error ? color.error : isActive ? color.brand[500] : color.border.strong,
                backgroundColor: color.surface.base,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {/* [F-028-18] The BOX's width growth caps at 2× (above), but the
                  glyph kept scaling past it — at accessibility scales >2× the
                  digit overflowed or clipped inside the door-to-the-account
                  input. The glyph now caps exactly where its box does; the
                  surrounding screen text still scales fully. */}
              <T variant="displayXl" tone={error ? 'error' : 'ink'} maxFontSizeMultiplier={2}>
                {filled ? digits[i] : ''}
              </T>
            </View>
          );
        })}
      </Animated.View>
      <TextInput
        ref={input}
        value={value}
        onChangeText={(v) => onChange(v.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus={autoFocus}
        style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
      />
    </Pressable>
  );
}
