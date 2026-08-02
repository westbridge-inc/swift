import { useEffect, useState } from 'react';
import { ActivityIndicator, View, StyleSheet, type ViewProps, type LayoutChangeEvent } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { withAlpha, color } from '@swift/ui';
import { cn } from './cn';

export function Spinner({ size = 'small' }: { size?: 'small' | 'large' }) {
  return <ActivityIndicator size={size} color={color.brand[500]} />;
}

/**
 * Loading placeholder with a real **shimmer sweep** — a soft highlight travels
 * across the block (vs the old static opacity pulse). Same API: pass `className`
 * for size (e.g. `h-48 w-full rounded-2xl`), so every existing call-site upgrades
 * for free.
 */
export function Skeleton({ className, ...props }: ViewProps & { className?: string }) {
  const [w, setW] = useState(0);
  const x = useSharedValue(0);

  useEffect(() => {
    if (w === 0) return;
    x.value = 0;
    x.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, false);
  }, [w, x]);

  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: -w + x.value * 2 * w }] }));
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  return (
    <View onLayout={onLayout} className={cn('bg-surface-subtle overflow-hidden rounded-md', className)} {...props}>
      {w > 0 ? (
        <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
          <View style={{ height: '100%', width: w * 0.5, backgroundColor: withAlpha(color.white, 0.6) }} />
        </Animated.View>
      ) : null}
    </View>
  );
}
