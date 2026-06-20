import { FadeIn, FadeInUp } from 'react-native-reanimated';
import { motion } from '@swift/ui';

/**
 * Content-entrance presets (reanimated) — use on `<Animated.View entering={...}>`.
 * `staggerDelay(i)` spaces list items into a cascade. Timing comes from motion tokens.
 */
export const enter = {
  fade: FadeIn.duration(motion.duration.base),
  fadeUp: FadeInUp.duration(motion.duration.base),
};

export const staggerDelay = (index: number, step = 40) => index * step;

/**
 * native-stack screen transition preset — a consistent push feel across stacks.
 * Spread into a navigator's `screenOptions`.
 */
export const screenTransition = {
  animation: 'slide_from_right',
  animationDuration: motion.duration.base,
} as const;
