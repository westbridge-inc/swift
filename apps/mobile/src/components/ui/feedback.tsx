import { useEffect } from 'react';
import { ActivityIndicator, View, type ViewProps } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { color } from '@swift/ui';
import { cn } from './cn';

export function Spinner({ size = 'small' }: { size?: 'small' | 'large' }) {
  return <ActivityIndicator size={size} color={color.brand[500]} />;
}

/** Shimmering placeholder block for loading states (pulsing opacity loop). */
export function Skeleton({ className, ...props }: ViewProps & { className?: string }) {
  const opacity = useSharedValue(0.4);
  useEffect(() => {
    opacity.value = withRepeat(withSequence(withTiming(0.85, { duration: 650 }), withTiming(0.4, { duration: 650 })), -1, false);
  }, [opacity]);
  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={animStyle}>
      <View className={cn('bg-surface-subtle rounded-md', className)} {...props} />
    </Animated.View>
  );
}
