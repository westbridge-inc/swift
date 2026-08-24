/** @jsxImportSource react */
import React from 'react';
import { AccessibilityInfo, type ViewStyle } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { color, motion, radius, space } from '@swift/ui';
import { T } from './text';

/**
 * THE LOCK-IN — the app's one CONFIRMED-SUCCESS moment [100x design pass, §1c].
 *
 * The pass defines it on the PIN handover, where a driver at the kerb needs
 * certainty in a second: *"on the sixth digit the boxes fill brand, digits flip
 * white, a viridian tick pops (≤600ms, celebrate spring)"*, and the copy
 * *"confirms the act"* rather than naming a system state.
 *
 * It is a component rather than a one-off because the same ceremony belongs
 * wherever something is IRREVERSIBLY, SERVER-CONFIRMED done: the code accepted,
 * the order placed, the money seen landing. One motion, one colour, one
 * meaning — so a customer learns the shape of "that worked" once.
 *
 * Two laws bind it:
 *
 *  • Viridian is RESERVED (palette law): delivered / paid / accepted. A
 *    confirmed success is exactly what it is for, and nothing else may borrow
 *    it. That is why this component takes no colour prop.
 *
 *  • The UI never lies. Render it only AFTER the server has confirmed — never
 *    optimistically, never on a request that is still in flight. A tick that
 *    pops before the truth arrives is the worst thing this component could do,
 *    which is why it has no "pending" state to be tempted by.
 *
 * Honours the system reduce-motion setting: the tick still appears, it simply
 * stops springing.
 */
export function LockIn({
  label,
  style,
}: {
  /** Confirms the ACT in the user's words — "Code accepted — locked in." */
  label: string;
  style?: ViewStyle;
}) {
  const scale = useSharedValue(0.6);
  const opacity = useSharedValue(0);

  React.useEffect(() => {
    // The tick pops; the row fades with it so it reads as one gesture.
    scale.value = withSpring(1, { ...motion.spring.celebrate, reduceMotion: ReduceMotion.System });
    opacity.value = withTiming(1, { duration: motion.duration.base, reduceMotion: ReduceMotion.System });
    // A success a screen reader cannot hear is not a success.
    AccessibilityInfo.announceForAccessibility?.(label);
  }, [label, opacity, scale]);

  const tick = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }], opacity: opacity.value }));
  const row = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      accessibilityRole="alert"
      accessibilityLabel={label}
      style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm }, row, style]}
    >
      <Animated.View
        style={[
          {
            width: 22,
            height: 22,
            borderRadius: radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color.success,
          },
          tick,
        ]}
      >
        <Feather name="check" size={14} color={color.white} />
      </Animated.View>
      <T variant="label" weight="semibold" style={{ color: color.success }}>
        {label}
      </T>
    </Animated.View>
  );
}

/**
 * The CTA that follows a lock-in. The pass turns the button viridian at the
 * moment the act is confirmed — "Start trip" after the code is accepted — so
 * the eye lands on the one thing left to do. Same reservation applies: this is
 * for a confirmed success, never for an ordinary primary action.
 */
export function lockInButtonStyle(): ViewStyle {
  return { backgroundColor: color.success, borderColor: color.success };
}

/**
 * The larger sibling: a confirmed-success DISC for a full-screen moment —
 * the order placed, the booking requested, the trip complete. Same viridian,
 * same celebrate spring, same law: it appears only after the server said yes.
 *
 * The order-placed popup used to show this disc in brand maroon, which made
 * "done" look identical to "act" — the exact collision the 100x pass calls out
 * when it reserves red for the rail, the flagship and CTAs.
 */
export function LockInDisc({ size = 64, style }: { size?: number; style?: ViewStyle }) {
  const scale = useSharedValue(0.6);

  React.useEffect(() => {
    scale.value = withSpring(1, { ...motion.spring.celebrate, reduceMotion: ReduceMotion.System });
  }, [scale]);

  const pop = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: color.success,
        },
        pop,
        style,
      ]}
    >
      <Feather name="check" size={Math.round(size * 0.47)} color={color.white} />
    </Animated.View>
  );
}
