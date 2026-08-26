import type { ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { motion } from '@swift/ui';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The app-wide tactile press: a Pressable that scales down while pressed and
 * springs back, driven by motion tokens. Single source of the press-scale
 * idiom. `strong` uses the larger dip — for big tappable tiles; default is
 * for cards.
 *
 * [DRIFT-09] Kit port of components/ui/pressable-scale. One deliberate
 * difference: no `className` passthrough — the kit styles through tokens and
 * `style` only.
 */
export function PressableScale({
  children,
  strong,
  style,
  ...props
}: PressableProps & { children?: ReactNode; strong?: boolean; style?: StyleProp<ViewStyle> }) {
  const scale = useSharedValue(1);
  const target = strong ? motion.scale.pressStrong : motion.scale.press;
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withTiming(target, { duration: motion.duration.instant });
      }}
      onPressOut={() => {
        scale.value = withTiming(1, { duration: motion.duration.fast });
      }}
      style={[style, animStyle]}
      {...props}
    >
      {children}
    </AnimatedPressable>
  );
}
